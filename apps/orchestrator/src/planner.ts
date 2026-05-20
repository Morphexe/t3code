import type { CardInput } from "./kanban";
import { loadWorkflow } from "./workflow";
import {
  createAgentSession,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { RealtimeHub } from "./realtime";
import { T3Client, finalAssistantMessage } from "./t3-client";
import { defaultTicketCreationWorkflowPath } from "./storage";

export type PlannerMessage = {
  id: string;
  role: "user" | "assistant";
  body: string;
  created_at: string;
};

export type PlannerDraft = {
  title: string;
  goal: string;
  acceptance_criteria: string[];
  labels: string[];
  priority: number | null;
  constraints: string[];
  notes: string[];
  state: string;
  ready: boolean;
};

export type PlannerSession = {
  id: string;
  messages: PlannerMessage[];
  draft: PlannerDraft;
  created_at: string;
  updated_at: string;
};

const sessions = new Map<string, PlannerSession>();
const defaultPlannerCommand = "t3";
let realtimeHub: RealtimeHub | null = null;

export function setPlannerRealtimeHub(hub: RealtimeHub) {
  realtimeHub = hub;
}
const defaultTicketWorkflowPath = defaultTicketCreationWorkflowPath();

export function createPlannerSession(): PlannerSession {
  const now = new Date().toISOString();
  const session: PlannerSession = {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    draft: emptyDraft(),
    messages: [
      {
        id: crypto.randomUUID(),
        role: "assistant",
        body: "Tell me what you want built or fixed. I will turn the conversation into a ticket with a goal, acceptance criteria, priority, labels, and planning notes.",
        created_at: now,
      },
    ],
  };
  sessions.set(session.id, session);
  return session;
}

export function getPlannerSession(id: string): PlannerSession | null {
  return sessions.get(id) ?? null;
}

export function addPlannerMessage(sessionId: string, body: string): PlannerSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const text = normalizeInputText(body).trim();
  if (!text) return session;
  session.messages.push(message("user", text));
  session.draft = updateDraft(session.draft, text, session.messages);
  session.messages.push(message("assistant", nextAssistantMessage(session.draft, text)));
  session.updated_at = new Date().toISOString();
  sessions.set(session.id, session);
  return session;
}

export async function addPlannerMessageWithAgent(
  sessionId: string,
  body: string,
): Promise<PlannerSession | null> {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const text = normalizeInputText(body).trim();
  if (!text) return session;
  session.messages.push(message("user", text));

  const fallbackDraft = updateDraft(session.draft, text, session.messages);
  const fallbackReply = nextAssistantMessage(fallbackDraft, text);

  const agentResult = await runPlannerAgent(session, fallbackDraft).catch((error) => {
    realtimeHub?.publishPlannerEvent(session.id, { type: "planner.error", error: String(error) });
    return null;
  });
  if (agentResult) {
    session.draft = normalizeAgentDraft(agentResult.draft, fallbackDraft);
    session.messages.push(message("assistant", agentResult.reply || fallbackReply));
  } else {
    session.draft = fallbackDraft;
    session.messages.push(message("assistant", fallbackReply));
  }

  session.updated_at = new Date().toISOString();
  sessions.set(session.id, session);
  realtimeHub?.publishPlannerDone(session.id, session);
  return session;
}

export function plannerDraftToCardInput(draft: PlannerDraft): CardInput {
  return {
    title: draft.title || "Planned ticket",
    description: renderDescription(draft),
    priority: draft.priority,
    state: draft.state,
    labels: unique(["planned", ...draft.labels]),
    extra_data: {
      source: "planner_chat",
      acceptance_criteria: draft.acceptance_criteria,
      constraints: draft.constraints,
      planning_notes: draft.notes,
    },
  };
}

export function renderPlanningComment(session: PlannerSession): string {
  const turns = session.messages
    .filter((item) => item.role === "user")
    .map((item) => `- ${item.body}`)
    .join("\n");
  return `Created from planner chat.\n\nConversation inputs:\n${turns || "- No user input captured."}`;
}

function emptyDraft(): PlannerDraft {
  return {
    title: "",
    goal: "",
    acceptance_criteria: [],
    labels: [],
    priority: null,
    constraints: [],
    notes: [],
    state: "Todo",
    ready: false,
  };
}

function message(role: PlannerMessage["role"], body: string): PlannerMessage {
  return { id: crypto.randomUUID(), role, body, created_at: new Date().toISOString() };
}

function updateDraft(
  current: PlannerDraft,
  input: string,
  messages: PlannerMessage[],
): PlannerDraft {
  const conversationOnly = isConversationOnly(input);
  const draft: PlannerDraft = {
    ...current,
    acceptance_criteria: [...current.acceptance_criteria],
    labels: [...current.labels],
    constraints: [...current.constraints],
    notes: [...current.notes],
  };

  const title = extractNamedValue(input, ["title", "ticket", "card"]);
  if (title) draft.title = cleanTitle(title);
  else if (!draft.title && !conversationOnly) draft.title = cleanTitle(inferTitle(input));

  const goal = extractNamedValue(input, ["goal", "problem", "summary", "description"]);
  if (goal) draft.goal = goal;
  else if (!draft.goal && !conversationOnly && input.length > 24) draft.goal = input;

  const acceptance = extractListAfter(input, ["acceptance", "criteria", "done when", "should"]);
  draft.acceptance_criteria = unique([...draft.acceptance_criteria, ...acceptance]);
  if (!draft.acceptance_criteria.length && shouldTreatAsAcceptanceFollowUp(current, input)) {
    draft.acceptance_criteria = unique([
      ...draft.acceptance_criteria,
      acceptanceFromFollowUp(input, draft),
    ]);
  }
  if (!draft.acceptance_criteria.length && allowsPlannerInference(input)) {
    draft.acceptance_criteria = inferAcceptanceCriteria(draft);
  }

  const constraints = extractListAfter(input, [
    "constraint",
    "constraints",
    "must",
    "avoid",
    "don't",
    "do not",
    "use",
  ]);
  draft.constraints = unique([...draft.constraints, ...constraints]);

  const labels = conversationOnly ? [] : extractLabels(input);
  draft.labels = unique([...draft.labels, ...labels]);

  const priority = extractPriority(input);
  if (priority) draft.priority = priority;

  if (isNote(input)) draft.notes = unique([...draft.notes, input]);
  if (!draft.labels.length) {
    draft.labels = inferLabels(
      messages
        .filter((item) => item.role === "user" && !isConversationOnly(item.body))
        .map((item) => item.body)
        .join(" "),
    );
  }
  draft.ready = Boolean(draft.title && draft.goal && draft.acceptance_criteria.length > 0);
  return draft;
}

function nextAssistantMessage(draft: PlannerDraft, lastUserMessage = ""): string {
  const missing: string[] = [];
  if (!draft.title) missing.push("a short title");
  if (!draft.goal) missing.push("the goal or problem");
  if (!draft.acceptance_criteria.length) missing.push("acceptance criteria");

  if (missing.length) {
    if (!draft.acceptance_criteria.length && draft.title && draft.goal) {
      return `Got it. What should be true when this is done? A short answer is fine, for example "committed locally" or "tests pass". You can also say "you can figure it out" and I will infer the criteria.`;
    }
    return `Got it. Next I need ${formatList(missing)}. Answer naturally; I will update the draft from the conversation.`;
  }

  const priority = draft.priority ? `P${draft.priority}` : "no priority yet";
  const acknowledgement = allowsPlannerInference(lastUserMessage)
    ? "I inferred the missing acceptance criteria."
    : "I updated the ticket draft.";
  return `${acknowledgement} It is ready to create: "${draft.title}", ${draft.acceptance_criteria.length} acceptance item${draft.acceptance_criteria.length === 1 ? "" : "s"}, ${priority}, labels ${draft.labels.length ? draft.labels.join(", ") : "planned"}.`;
}

function renderDescription(draft: PlannerDraft): string {
  const lines = [`Goal`, draft.goal || "TBD", ""];
  if (draft.acceptance_criteria.length) {
    lines.push("Acceptance criteria", ...draft.acceptance_criteria.map((item) => `- ${item}`), "");
  }
  if (draft.constraints.length) {
    lines.push("Constraints", ...draft.constraints.map((item) => `- ${item}`), "");
  }
  if (draft.notes.length) {
    lines.push("Planning notes", ...draft.notes.map((item) => `- ${item}`));
  }
  return lines.join("\n").trim();
}

function extractNamedValue(input: string, names: string[]) {
  for (const name of names) {
    const match = input.match(new RegExp(`${escapeRegex(name)}\\s*:\\s*([^\\n;]+)`, "i"));
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function extractListAfter(input: string, names: string[]) {
  const lines = input
    .split(/\n|;/)
    .map((line) => line.trim())
    .filter(Boolean);
  const found: string[] = [];
  const wantsAcceptance = names.some((name) =>
    ["acceptance", "criteria", "done when", "should"].includes(name),
  );
  for (const line of lines) {
    const normalized = line.replace(/^[-*]\s*/, "");
    const named = extractNamedValue(normalized, names);
    if (named) found.push(named);
    else if (wantsAcceptance && /^(it should|should|must|done when|acceptance)/i.test(normalized))
      found.push(normalized.replace(/^(it should|should|must|done when)\s*/i, ""));
  }
  return found.map(cleanSentence).filter((item) => item.length > 3);
}

function extractLabels(input: string) {
  const explicit = extractNamedValue(input, ["labels", "label"]);
  const labels = explicit ? explicit.split(/[, ]+/) : [];
  const hashtags = [...input.matchAll(/#([a-z0-9_-]+)/gi)].map((match) => match[1] ?? "");
  return unique([...labels, ...hashtags, ...inferLabels(input)])
    .map((label) => label.toLowerCase())
    .filter(Boolean);
}

function inferLabels(input: string) {
  const lower = input.toLowerCase();
  const labels: string[] = [];
  if (/(ui|ux|frontend|react|vite|tailwind|page|screen|modal|button)/.test(lower))
    labels.push("frontend");
  if (/(api|endpoint|server|backend|database|sqlite|schema)/.test(lower)) labels.push("api");
  if (/(agent|orchestrator|codex|workflow|run|sandbox)/.test(lower)) labels.push("agent");
  if (/(bug|error|failed|broken|fix|regression)/.test(lower)) labels.push("bug");
  if (/(test|typecheck|validation|coverage)/.test(lower)) labels.push("testing");
  return unique(labels);
}

function extractPriority(input: string) {
  const match = input.match(/\b(?:p|priority)\s*[:#-]?\s*([1-5])\b/i);
  return match?.[1] ? Number(match[1]) : null;
}

function inferTitle(input: string) {
  const first = input.split("\n").find((line) => line.trim()) ?? input;
  return first
    .replace(/^(i want|we need|we should|please|can you|build|create|fix)\s+/i, "")
    .replace(/^(to do|to make|to add|to create|to fix)\s+/i, "")
    .trim();
}

function cleanTitle(input: string) {
  const title = cleanSentence(input).replace(/[.]+$/, "");
  return title.length > 90 ? `${title.slice(0, 87)}...` : title;
}

function cleanSentence(input: string) {
  return input
    .replace(/^[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNote(input: string) {
  return /(context|note|remember|planning|handoff|constraint|must|avoid|don't|do not)/i.test(input);
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function formatList(items: string[]) {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeInputText(value: string) {
  return value.replace(/\\n/g, "\n");
}

function isConversationOnly(input: string) {
  const normalized = input.trim().toLowerCase();
  return /^(hello|hi|hey|yo|sup|help|thanks|thank you|ok|okay|\?+|what\?|why\?)$/.test(normalized);
}

function isPlaceholderTitle(input: string) {
  return (
    isConversationOnly(input) || ["hello", "hi", "hey", "?"].includes(input.trim().toLowerCase())
  );
}

type PlannerAgentResult = {
  reply: string;
  draft: Partial<PlannerDraft>;
};

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type TicketCreationWorkflowConfig = {
  path: string;
  command: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  timeoutMs: number;
  disabled: boolean;
  promptTemplate: string;
};

export async function loadTicketCreationWorkflow(
  workflowPath = process.env.TICKET_CREATION_WORKFLOW ?? defaultTicketWorkflowPath,
): Promise<TicketCreationWorkflowConfig> {
  const workflow = await loadWorkflow(workflowPath);
  const planner = objectField(workflow.config, "planner");
  const model = process.env.PLANNER_AGENT_MODEL ?? nullableStringField(planner, "model");
  const reasoningEffort = reasoningEffortValue(
    process.env.PLANNER_AGENT_REASONING_EFFORT ?? nullableStringField(planner, "reasoning_effort"),
  );
  const command = buildPlannerCommand(
    process.env.PLANNER_AGENT_COMMAND ??
      stringFieldWithDefault(planner, "command", defaultPlannerCommand),
    model,
    reasoningEffort,
  );

  return {
    path: workflow.path,
    command,
    model,
    reasoningEffort,
    timeoutMs: positiveInteger(
      process.env.PLANNER_AGENT_TIMEOUT_MS,
      positiveInteger(planner.timeout_ms, 45000),
    ),
    disabled:
      process.env.PLANNER_AGENT_DISABLED === "1" || booleanField(planner, "disabled", false),
    promptTemplate: workflow.prompt_template,
  };
}

async function runPlannerAgent(
  session: PlannerSession,
  fallbackDraft: PlannerDraft,
): Promise<PlannerAgentResult | null> {
  if (process.env.PLANNER_AGENT_DISABLED === "1") return null;
  const config = await loadTicketCreationWorkflow();
  if (config.disabled || config.command.trim().toLowerCase() === "off") return null;
  if (config.command.trim().toLowerCase() === "t3")
    return runPlannerT3(session, fallbackDraft, config);
  if (config.command.trim().toLowerCase() === "pi-sdk")
    return runPlannerPiSdk(session, fallbackDraft, config);
  const proc = Bun.spawn(["bash", "-lc", config.command], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(plannerPrompt(config.promptTemplate, session, fallbackDraft));
  proc.stdin.end();

  const timeout = setTimeout(() => proc.kill(), config.timeoutMs);
  timeout.unref();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  if (code !== 0) return null;
  return extractPlannerResult(`${stdout}\n${stderr}`);
}

async function runPlannerT3(
  session: PlannerSession,
  fallbackDraft: PlannerDraft,
  config: TicketCreationWorkflowConfig,
): Promise<PlannerAgentResult | null> {
  const workspacePath = process.cwd();
  const client = new T3Client({
    kind: "t3",
    base_url:
      process.env.T3CODE_BASE_URL ?? `http://localhost:${process.env.T3CODE_PORT ?? "3002"}`,
    auth_token: process.env.T3CODE_AUTH_TOKEN ?? "",
    provider_instance: process.env.T3CODE_PROVIDER_INSTANCE ?? "codex",
    project_id: null,
    model: config.model ?? "gpt-5.5",
    runtime_mode: "full-access",
    interaction_mode: "default",
    poll_interval_ms: 1000,
  });
  const threadId = `symphony-planner-${session.id}`;
  const project = await client.ensureProject(workspacePath, "Symphony planner");
  realtimeHub?.publishPlannerEvent(session.id, {
    type: "t3.session",
    thread_id: threadId,
    project_id: project.id,
    provider: "t3",
  });
  const snapshot = await client.snapshot();
  await client.startTurn({
    threadId,
    projectId: project.id,
    title: "Symphony planner",
    prompt: plannerPrompt(config.promptTemplate, session, fallbackDraft),
    workspacePath,
    createThread: !snapshot.threads.some((thread) => thread.id === threadId),
  });
  let streamedText = "";
  const result = await client.waitForTurn({
    threadId,
    timeoutMs: config.timeoutMs,
    onThread: (thread, snapshot) => {
      const fullText = finalAssistantMessage(thread) ?? "";
      const delta = fullText.startsWith(streamedText)
        ? fullText.slice(streamedText.length)
        : fullText;
      streamedText = fullText;
      realtimeHub?.publishPlannerEvent(session.id, {
        type: "t3.thread.snapshot",
        provider: "t3",
        text: delta,
        provider_event: {
          kind: "thread.snapshot",
          thread,
          snapshotSequence: snapshot.snapshotSequence,
          updatedAt: snapshot.updatedAt,
        },
      });
    },
  });
  if (!result.ok) return null;
  return extractPlannerResult(result.finalMessage ?? "");
}

async function runPlannerPiSdk(
  session: PlannerSession,
  fallbackDraft: PlannerDraft,
  config: TicketCreationWorkflowConfig,
): Promise<PlannerAgentResult | null> {
  let finalText = "";
  const created = await createAgentSession({
    cwd: process.cwd(),
    sessionManager: SessionManager.create(process.cwd()),
  });
  const agentSession = created.session;
  realtimeHub?.publishPlannerEvent(session.id, {
    type: "planner.session",
    session_id: agentSession.sessionId,
    model: agentSession.model ? `${agentSession.model.provider}/${agentSession.model.id}` : null,
  });
  const unsubscribe = agentSession.subscribe((event) => {
    const text = plannerEventText(event);
    if (text) finalText += text;
    realtimeHub?.publishPlannerEvent(session.id, { type: "pi_event", pi_event: event, text });
  });
  const timeout = setTimeout(() => void agentSession.abort(), config.timeoutMs);
  timeout.unref();
  try {
    await agentSession.prompt(plannerPrompt(config.promptTemplate, session, fallbackDraft), {
      expandPromptTemplates: false,
      source: "rpc",
    });
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    agentSession.dispose();
  }
  return extractPlannerResult(finalText);
}

function plannerEventText(event: AgentSessionEvent): string {
  const record = event as unknown as Record<string, unknown>;
  const assistantEvent = record.assistantMessageEvent as Record<string, unknown> | undefined;
  if (assistantEvent?.type === "text_delta") {
    return String(
      assistantEvent.text_delta ??
        assistantEvent.textDelta ??
        assistantEvent.delta ??
        assistantEvent.text ??
        "",
    );
  }
  if (event.type === "message_end" || event.type === "agent_end") {
    const message = record.message as Record<string, unknown> | string | undefined;
    if (typeof message === "string") return message;
    if (message && typeof message === "object")
      return String(message.text ?? message.content ?? "");
  }
  return "";
}

function plannerPrompt(
  promptTemplate: string,
  session: PlannerSession,
  fallbackDraft: PlannerDraft,
) {
  return `${promptTemplate}

Current draft:
${JSON.stringify(session.draft, null, 2)}

Parser fallback draft, if useful:
${JSON.stringify(fallbackDraft, null, 2)}

Transcript:
${session.messages.map((item) => `${item.role}: ${item.body}`).join("\n")}
`;
}

function buildPlannerCommand(
  command: string,
  model: string | null,
  reasoningEffort: ReasoningEffort | null,
) {
  const args: string[] = [];
  if (model && !/\s(?:-m|--model)(?:\s|=)/.test(` ${command} `)) {
    args.push("-m", shellArg(model));
  }
  if (reasoningEffort && !command.includes("model_reasoning_effort")) {
    args.push("-c", shellArg(`model_reasoning_effort=${JSON.stringify(reasoningEffort)}`));
  }
  if (!args.length) return command;

  const trimmed = command.trim();
  if (trimmed.endsWith(" -")) return `${trimmed.slice(0, -2)} ${args.join(" ")} -`;
  return `${trimmed} ${args.join(" ")}`;
}

function shellArg(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function objectField(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : {};
}

function nullableStringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function stringFieldWithDefault(value: Record<string, unknown>, key: string, fallback: string) {
  return nullableStringField(value, key) ?? fallback;
}

function reasoningEffortValue(value: string | null): ReasoningEffort | null {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  return null;
}

function positiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function booleanField(value: Record<string, unknown>, key: string, fallback: boolean) {
  const field = value[key];
  return typeof field === "boolean" ? field : fallback;
}

function normalizeAgentDraft(input: Partial<PlannerDraft>, fallback: PlannerDraft): PlannerDraft {
  const agentTitle = stringField(input.title);
  const fallbackTitle = isPlaceholderTitle(fallback.title) ? "" : fallback.title;
  const draft: PlannerDraft = {
    title: isPlaceholderTitle(agentTitle) ? fallbackTitle : agentTitle || fallbackTitle,
    goal: stringField(input.goal) || fallback.goal,
    acceptance_criteria: stringArray(input.acceptance_criteria, fallback.acceptance_criteria),
    labels: stringArray(input.labels, fallback.labels),
    priority: priorityField(input.priority) ?? fallback.priority,
    constraints: stringArray(input.constraints, fallback.constraints),
    notes: stringArray(input.notes, fallback.notes),
    state: stringField(input.state) || fallback.state || "Todo",
    ready: false,
  };
  if (!draft.labels.length) draft.labels = fallback.labels;
  draft.ready = Boolean(draft.title && draft.goal && draft.acceptance_criteria.length > 0);
  return draft;
}

export function extractPlannerResult(output: string): PlannerAgentResult | null {
  const candidates = collectCandidateStrings(output);
  for (const candidate of candidates.toReversed()) {
    const parsed = parseJsonObject(candidate);
    const result = coercePlannerAgentResult(parsed);
    if (result) return result;
  }
  return null;
}

function collectCandidateStrings(output: string): string[] {
  const candidates: string[] = [output];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    candidates.push(trimmed);
    try {
      collectStrings(JSON.parse(trimmed), candidates);
    } catch {
      // Plain text line.
    }
  }
  return candidates;
}

function collectStrings(value: unknown, target: string[]) {
  if (typeof value === "string") {
    target.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, target);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, target);
  }
}

function parseJsonObject(value: string): unknown {
  const unfenced = value
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

function coercePlannerAgentResult(value: unknown): PlannerAgentResult | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.reply !== "string") return null;
  if (record.draft && typeof record.draft === "object") {
    return { reply: record.reply, draft: record.draft as Partial<PlannerDraft> };
  }
  const toolCall = objectField(record, "tool_call");
  if (toolCall.name !== "upsert_ticket_draft") return null;
  const args = objectField(toolCall, "arguments");
  return { reply: record.reply, draft: args as Partial<PlannerDraft> };
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  return unique(value.filter((item): item is string => typeof item === "string"));
}

function priorityField(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const priority = Number(value);
  return Number.isInteger(priority) && priority >= 1 && priority <= 5 ? priority : null;
}

function allowsPlannerInference(input: string) {
  return /(you can figure it out|figure it out|use your judgment|use your judgement|decide|infer|make it up|reasonable defaults|whatever makes sense)/i.test(
    input,
  );
}

function shouldTreatAsAcceptanceFollowUp(current: PlannerDraft, input: string) {
  if (!current.title || !current.goal || current.acceptance_criteria.length) return false;
  if (
    extractPriority(input) ||
    extractNamedValue(input, [
      "title",
      "ticket",
      "card",
      "goal",
      "problem",
      "summary",
      "description",
      "labels",
      "label",
    ])
  )
    return false;
  if (allowsPlannerInference(input)) return false;
  const text = input.trim();
  if (!text) return false;
  return (
    text.length < 180 ||
    /\b(done|commit|committed|local|locally|test|pass|works|validate|ship|created|updated)\b/i.test(
      text,
    )
  );
}

function acceptanceFromFollowUp(input: string, draft: PlannerDraft) {
  const text = cleanSentence(input).replace(/[.]+$/, "");
  const source = `${draft.title} ${draft.goal}`.toLowerCase();
  if (
    /\b(local|locally|commit|committed)\b/i.test(text) &&
    /semantic commit|semantic commits|conventional commit|conventional commits/.test(source)
  ) {
    return "Semantic commits are created locally for the repository changes.";
  }
  if (/^(this is|it is|should be|needs to be)\s+/i.test(text)) {
    return cleanSentence(text.replace(/^(this is|it is|should be|needs to be)\s+/i, ""));
  }
  return text[0] ? `${text[0].toUpperCase()}${text.slice(1)}.` : text;
}

function inferAcceptanceCriteria(draft: PlannerDraft) {
  const source = `${draft.title} ${draft.goal}`.toLowerCase();
  if (/semantic commit|semantic commits|conventional commit|conventional commits/.test(source)) {
    return [
      "Relevant changes are committed with semantic commit messages.",
      "Commit messages clearly describe the scope and intent of each change.",
      "Unrelated changes are not bundled into the same commit.",
    ];
  }
  if (/ui|ux|frontend|screen|page|modal|drawer|button|layout/.test(source)) {
    return [
      "The requested UI flow is implemented and reachable from the app.",
      "The interface handles empty, loading, error, and success states cleanly.",
      "The layout remains usable on typical desktop and narrow viewports.",
    ];
  }
  if (/api|endpoint|server|backend|database|sqlite/.test(source)) {
    return [
      "The required backend behavior is exposed through a clear API or service path.",
      "Invalid input and failure cases return actionable errors.",
      "Existing tests or focused validation cover the new behavior.",
    ];
  }
  if (/bug|error|failed|broken|fix|regression/.test(source)) {
    return [
      "The reported failure no longer reproduces.",
      "The fix preserves the existing intended behavior.",
      "A regression check or documented validation confirms the fix.",
    ];
  }
  return [
    "The requested behavior is implemented end to end.",
    "Important edge cases and failure states are handled.",
    "The change is validated with the appropriate local checks.",
  ];
}
