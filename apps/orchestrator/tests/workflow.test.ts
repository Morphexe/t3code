import { expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadWorkflow,
  parseWorkflowSource,
  updateWorkflowSourceConfig,
  WorkflowError,
} from "../src/workflow";
import { resolveConfig } from "../src/config";
import { renderTemplate, TemplateError } from "../src/template";
import { KanbanStore } from "../src/kanban";
import { AgentRunner, summarizeAgentEvent } from "../src/agent-runner";
import type { EffectiveConfig, Issue, RunningEntry } from "../src/types";
import {
  addPlannerMessage,
  addPlannerMessageWithAgent,
  createPlannerSession,
  extractPlannerResult,
  loadTicketCreationWorkflow,
  plannerDraftToCardInput,
} from "../src/planner";
import { getWorkspaceDiff } from "../src/workspace-diff";
import {
  ensureProjectOrchestrationFiles,
  ORCHESTRATION_DIR,
  resolveOrchestrationStoragePaths,
} from "../src/storage";

test("project orchestration storage seeds workflow files under .t3code/orchestration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-storage-"));
  const templates = path.join(dir, "templates");
  try {
    await mkdir(templates);
    await writeFile(path.join(templates, "WORKFLOW.md"), "workflow-template");
    await writeFile(path.join(templates, "TICKET_CREATION_WORKFLOW.MD"), "ticket-template");

    const paths = await ensureProjectOrchestrationFiles({
      projectRoot: dir,
      templatesRoot: templates,
    });

    expect(paths.orchestrationDir).toBe(path.join(dir, ORCHESTRATION_DIR));
    expect(paths.workflowPath).toBe(path.join(dir, ".t3code", "orchestration", "WORKFLOW.md"));
    expect(paths.kanbanDbPath).toBe(path.join(dir, ".t3code", "orchestration", "kanban.sqlite"));
    expect(await readFile(paths.workflowPath, "utf8")).toBe("workflow-template");
    expect(await readFile(paths.ticketCreationWorkflowPath, "utf8")).toBe("ticket-template");

    await writeFile(paths.workflowPath, "project-edited");
    await ensureProjectOrchestrationFiles({ projectRoot: dir, templatesRoot: templates });
    expect(await readFile(paths.workflowPath, "utf8")).toBe("project-edited");
    expect(resolveOrchestrationStoragePaths(dir).workflowPath).toBe(paths.workflowPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loads workflow front matter and resolves relative workspace root", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-"));
  try {
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: kanban
  state_transitions:
    todo: Review
workspace:
  root: ./tmp-workspaces
---
Hello {{ issue.title }}
`,
    );
    const workflow = await loadWorkflow(workflowPath);
    const config = resolveConfig(workflow);
    expect(workflow.prompt_template).toBe("Hello {{ issue.title }}");
    expect(config.workspace.root).toBe(path.join(dir, "tmp-workspaces"));
    expect(config.tracker.state_transitions.get("todo")).toBe("Review");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parses workflow markdown source before saving edits", () => {
  const workflow = parseWorkflowSource(
    `---
tracker:
  kind: kanban
agent_plane:
  kind: t3
  base_url: http://localhost:3002
  provider_instance: codex
  model: gpt-5.5
---
Do {{ issue.title }}
`,
    "/tmp/WORKFLOW.md",
  );
  const config = resolveConfig(workflow);
  expect(workflow.path).toBe("/tmp/WORKFLOW.md");
  expect(config.agent_plane.provider_instance).toBe("codex");
  expect(workflow.prompt_template).toBe("Do {{ issue.title }}");
});

test("rejects invalid workflow front matter while editing", () => {
  expect(() =>
    parseWorkflowSource(
      `---
tracker: [
---
Broken
`,
      "/tmp/WORKFLOW.md",
    ),
  ).toThrow(WorkflowError);
});

test("codex output format defaults to codex-json and accepts pi-json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-format-"));
  try {
    const defaultWorkflowPath = path.join(dir, "DEFAULT_WORKFLOW.md");
    await writeFile(
      defaultWorkflowPath,
      `---
codex:
  command: codex exec --json -
---
Hello
`,
    );
    const defaultConfig = resolveConfig(await loadWorkflow(defaultWorkflowPath));
    expect(defaultConfig.codex.backend).toBe("cli");
    expect(defaultConfig.codex.output_format).toBe("codex-json");

    const piWorkflowPath = path.join(dir, "PI_WORKFLOW.md");
    await writeFile(
      piWorkflowPath,
      `---
codex:
  backend: pi-sdk
  command: PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 pi --mode json --no-session
  output_format: pi-json
---
Hello
`,
    );
    const piConfig = resolveConfig(await loadWorkflow(piWorkflowPath));
    expect(piConfig.codex.backend).toBe("pi-sdk");
    expect(piConfig.codex.output_format).toBe("pi-json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent plane config supports T3", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-t3-"));
  try {
    const workflowPath = path.join(dir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
agent_plane:
  kind: t3
  base_url: http://localhost:3002
  auth_token: test-token
  provider_instance: pi
  model: gpt-5.5
  runtime_mode: full-access
  interaction_mode: default
---
Hello
`,
    );
    const config = resolveConfig(await loadWorkflow(workflowPath));
    expect(config.agent_plane.kind).toBe("t3");
    expect(config.agent_plane.base_url).toBe("http://localhost:3002");
    expect(config.agent_plane.auth_token).toBe("test-token");
    expect(config.agent_plane.provider_instance).toBe("pi");
    expect(config.agent_plane.project_id).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workflow source config updates can persist a selected T3 project", () => {
  const source = `---
agent_plane:
  kind: t3
  base_url: http://localhost:3002
  provider_instance: codex
  model: gpt-5.5
---
Run {{ issue.title }}
`;
  const updated = updateWorkflowSourceConfig(source, (config) => {
    const agentPlane = config.agent_plane as Record<string, unknown>;
    agentPlane.project_id = "project-123";
  });
  const workflow = parseWorkflowSource(updated, "/tmp/WORKFLOW.md");
  const config = resolveConfig(workflow);
  expect(config.agent_plane.project_id).toBe("project-123");
  expect(workflow.prompt_template).toBe("Run {{ issue.title }}");
});

test("agent output adapter summarizes codex json lines", () => {
  const summary = summarizeAgentEvent(
    {
      type: "response.output_text.delta",
      delta: "Working",
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    },
    "codex-json",
  );
  expect(summary.codex_event_type).toBe("response.output_text.delta");
  expect(summary.message).toBe("Working");
  expect(summary.tokens).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  expect(summary.error).toBeNull();
});

test("agent output adapter summarizes pi json lines", () => {
  const update = summarizeAgentEvent(
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", textDelta: "Working" },
    },
    "pi-json",
  );
  expect(update.codex_event_type).toBe("pi.message_update");
  expect(update.message).toBe("Working");

  const end = summarizeAgentEvent(
    {
      type: "message_end",
      assistantMessage: {
        content: "Done",
        usage: { input: 3, output: 4, totalTokens: 7 },
        stopReason: "end_turn",
      },
    },
    "pi-json",
  );
  expect(end.finalMessage).toBe("Done");
  expect(end.tokens).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  expect(end.error).toBeNull();
});

test("pi assistant error stop reason fails the run even when process exits zero", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-pi-runner-"));
  try {
    const runner = new AgentRunner();
    const issue = makeIssue();
    const running = makeRunningEntry(issue, dir);
    const config = makeConfig(
      `printf '%s\\n' '{"type":"message_end","assistantMessage":{"content":"Failed final","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5},"stopReason":"error","error":"tool failed"}}'`,
    );
    const result = await runner.run(issue, "prompt", config, dir, running);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("tool failed");
    expect(result.finalMessage).toBe("Failed final");
    expect(result.inputTokens).toBe(2);
    expect(result.outputTokens).toBe(3);
    expect(result.totalTokens).toBe(5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("strict template rendering rejects unknown variables", () => {
  expect(() => renderTemplate("{{ issue.missing }}", { issue: { title: "A" } })).toThrow(
    TemplateError,
  );
});

test("kanban store creates and moves cards", () => {
  const store = new KanbanStore(":memory:");
  const card = store.createCard({
    title: "Build board",
    priority: 1,
    labels: ["UI"],
    extra_data: { acceptance: "loads" },
  });
  expect(card.identifier).toBe("KAN-1");
  expect(card.labels).toEqual(["ui"]);
  expect(card.extra_data.acceptance).toBe("loads");
  const comment = store.addComment(card.id, {
    author: "agent-0001",
    kind: "planning",
    body: "Plan before editing",
  });
  expect(comment?.body).toBe("Plan before editing");
  expect(store.getCard(card.id)?.comment_count).toBe(1);
  const moved = store.moveCard(card.id, "In Progress");
  expect(moved?.state).toBe("In Progress");
  expect(moved?.position).toBe(1);
  expect(store.listByStates(["In Progress"])).toHaveLength(1);
});

test("kanban store reorders cards by zero-based target position", () => {
  const store = new KanbanStore(":memory:");
  const first = store.createCard({ title: "First" });
  const second = store.createCard({ title: "Second" });
  const third = store.createCard({ title: "Third" });

  store.moveCard(third.id, "Todo", 0);
  expect(store.listByStates(["Todo"]).map((card) => card.id)).toEqual([
    third.id,
    first.id,
    second.id,
  ]);

  store.moveCard(first.id, "In Progress", 0);
  expect(store.listByStates(["Todo"]).map((card) => card.position)).toEqual([1, 2]);
  expect(store.listByStates(["In Progress"]).map((card) => card.id)).toEqual([first.id]);
});

test("kanban store persists agent runs and events separately from comments", () => {
  const store = new KanbanStore(":memory:");
  const card = store.createCard({ title: "Run task" });
  const run = store.createAgentRun({
    issue_id: card.id,
    identifier: card.identifier,
    agent_id: "agent-0001",
    status: "PreparingWorkspace",
    attempt: null,
    command: "codex exec -",
    model: null,
    profile: null,
  });
  store.addAgentEvent({
    run_id: run.id,
    issue_id: card.id,
    agent_id: "agent-0001",
    event_type: "agent_picked_card",
    message: "Picked card",
  });
  store.updateAgentRun(run.id, {
    status: "Succeeded",
    summary: "Done",
    finished_at: new Date().toISOString(),
  });
  const [saved] = store.listAgentRuns(card.id);
  expect(saved?.summary).toBe("Done");
  expect(saved?.events[0]?.event_type).toBe("agent_picked_card");
  expect(store.getCard(card.id)?.comment_count).toBe(0);
});

test("planner chat builds a ready card draft", () => {
  const session = createPlannerSession();
  const updated = addPlannerMessage(
    session.id,
    "Title: Add planner chat\\nGoal: Help users create tickets from a conversation\\nAcceptance: user can chat with planner\\nAcceptance: planner can create a Kanban card\\nPriority: 2\\nLabels: frontend, agent",
  );
  expect(updated?.draft.ready).toBe(true);
  expect(updated?.draft.priority).toBe(2);
  expect(updated?.draft.labels).toContain("frontend");
  const input = plannerDraftToCardInput(updated!.draft);
  expect(input.title).toBe("Add planner chat");
  expect(input.labels).toContain("planned");
  expect(input.extra_data?.source).toBe("planner_chat");
});

test("planner can infer acceptance criteria when user delegates judgment", () => {
  const session = createPlannerSession();
  addPlannerMessage(session.id, "We need to do semantic commits to the changes we have.");
  const updated = addPlannerMessage(session.id, "You can figure it out.");
  expect(updated?.draft.title).toBe("semantic commits to the changes we have");
  expect(updated?.draft.ready).toBe(true);
  expect(updated?.draft.acceptance_criteria[0]).toContain("semantic commit messages");
});

test("planner treats natural follow-up as acceptance when it asked for criteria", () => {
  const session = createPlannerSession();
  addPlannerMessage(session.id, "We need to create semantic commits for this repo.");
  const updated = addPlannerMessage(session.id, "this is locally commit");
  expect(updated?.draft.ready).toBe(true);
  expect(updated?.draft.acceptance_criteria).toContain(
    "Semantic commits are created locally for the repository changes.",
  );
  expect(updated?.messages.at(-1)?.body).toContain("ready to create");
});

test("planner agent result accepts chat reply with draft edit tool call", () => {
  const result = extractPlannerResult(
    JSON.stringify({
      reply: "I captured that. What should be true when it is done?",
      tool_call: {
        name: "upsert_ticket_draft",
        arguments: {
          title: "Improve planner chat",
          goal: "Make planning feel like a normal agent conversation.",
          acceptance_criteria: [],
          labels: ["frontend", "agent"],
          priority: null,
          constraints: ["Keep the structured ticket draft updated."],
          notes: ["User wants chat-first planning."],
          state: "Todo",
        },
      },
    }),
  );

  expect(result?.reply).toContain("captured");
  expect(result?.draft.title).toBe("Improve planner chat");
  expect(result?.draft.labels).toEqual(["frontend", "agent"]);
});

test("planner agent path falls back when disabled", async () => {
  process.env.PLANNER_AGENT_DISABLED = "1";
  try {
    const session = createPlannerSession();
    addPlannerMessage(session.id, "We need to create semantic commits for this repo.");
    const updated = await addPlannerMessageWithAgent(session.id, "this is locally commit");
    expect(updated?.draft.ready).toBe(true);
    expect(updated?.draft.acceptance_criteria).toContain(
      "Semantic commits are created locally for the repository changes.",
    );
  } finally {
    delete process.env.PLANNER_AGENT_DISABLED;
  }
});

test("ticket creation workflow configures planner command model and reasoning", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-ticket-workflow-"));
  try {
    const workflowPath = path.join(dir, "TICKET_CREATION_WORKFLOW.MD");
    await writeFile(
      workflowPath,
      `---
planner:
  command: codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -
  model: gpt-5.4-mini
  reasoning_effort: low
  timeout_ms: 12345
---
Create a ticket from the conversation.
`,
    );
    const config = await loadTicketCreationWorkflow(workflowPath);
    expect(config.model).toBe("gpt-5.4-mini");
    expect(config.reasoningEffort).toBe("low");
    expect(config.timeoutMs).toBe(12345);
    expect(config.command).toBe(
      "codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -m 'gpt-5.4-mini' -c 'model_reasoning_effort=\"low\"' -",
    );
    expect(config.promptTemplate).toBe("Create a ticket from the conversation.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace diff renders changed files from a git worktree", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-diff-"));
  try {
    await writeFile(path.join(dir, "README.md"), "hello\n");
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "Test User"]);
    await git(dir, ["add", "README.md"]);
    await git(dir, ["commit", "-m", "initial"]);
    await writeFile(path.join(dir, "README.md"), "hello\nworld\n");
    await writeFile(path.join(dir, "new.txt"), "new\n");

    const diff = await getWorkspaceDiff(dir);
    expect(diff.available).toBe(true);
    expect(diff.files.map((file) => file.path)).toContain("README.md");
    expect(diff.files.map((file) => file.path)).toContain("new.txt");
    expect(diff.patch).toContain("+world");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("planner does not turn greetings into ticket data", () => {
  const session = createPlannerSession();
  const hello = addPlannerMessage(session.id, "Hello");
  expect(hello?.draft.title).toBe("");
  expect(hello?.draft.labels).toEqual([]);
  const confused = addPlannerMessage(session.id, "?");
  expect(confused?.draft.title).toBe("");
  expect(confused?.draft.ready).toBe(false);
});

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

function makeIssue(): Issue {
  return {
    id: "issue-1",
    identifier: "KAN-1",
    title: "Run Pi",
    description: null,
    priority: null,
    state: "Todo",
    position: 1,
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    comments: [],
    comment_count: 0,
    extra_data: {},
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

function makeRunningEntry(issue: Issue, workspacePath: string): RunningEntry {
  return {
    run_id: "run-1",
    agent_id: "agent-0001",
    issue,
    attempt: null,
    workspace_path: workspacePath,
    prompt_preview: null,
    command: "pi --mode json --no-session",
    model: null,
    profile: null,
    pid: null,
    started_at: Date.now(),
    status: "PreparingWorkspace",
    process: null,
    abort: new AbortController(),
    last_codex_event: null,
    last_codex_timestamp: null,
    last_codex_message: null,
    codex_input_tokens: 0,
    codex_output_tokens: 0,
    codex_total_tokens: 0,
    turn_count: 0,
  };
}

function makeConfig(command: string): EffectiveConfig {
  return {
    workflow_path: "/tmp/WORKFLOW.md",
    workflow_dir: "/tmp",
    tracker: {
      kind: "kanban",
      active_states: ["Todo"],
      terminal_states: ["Done"],
      done_state: "Done",
      state_transitions: new Map(),
    },
    polling: { interval_ms: 30000 },
    workspace: { root: "/tmp/workspaces", seed_from: null, mode: "copy" },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 60000,
    },
    agent: {
      max_concurrent_agents: 1,
      max_turns: 1,
      max_retry_backoff_ms: 300000,
      max_concurrent_agents_by_state: new Map(),
    },
    agent_plane: {
      kind: "legacy",
      base_url: "http://localhost:3002",
      auth_token: "",
      provider_instance: "pi",
      project_id: null,
      model: "gpt-5.5",
      runtime_mode: "full-access",
      interaction_mode: "default",
      poll_interval_ms: 1000,
    },
    codex: {
      backend: "cli",
      command,
      output_format: "pi-json",
      approval_policy: null,
      thread_sandbox: null,
      turn_sandbox_policy: null,
      turn_timeout_ms: 60000,
      read_timeout_ms: 5000,
      stall_timeout_ms: 300000,
    },
  };
}
