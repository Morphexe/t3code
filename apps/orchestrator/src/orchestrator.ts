import { resolveConfig, validateDispatchConfig } from "./config";
import { AgentRunner } from "./agent-runner";
import { loadWorkflow, parseWorkflowSource, updateWorkflowSourceConfig } from "./workflow";
import { renderTemplate } from "./template";
import { isStateIn, normalizeState } from "./state";
import { WorkspaceManager } from "./workspace";
import { T3Client } from "./t3-client";
import type { EffectiveConfig, Issue, RetryEntry, RunningEntry, WorkflowDefinition } from "./types";
import type { KanbanStore } from "./kanban";
import type { Logger } from "./logger";
import type { RealtimeHub } from "./realtime";

export class Orchestrator {
  readonly running = new Map<string, RunningEntry>();
  readonly claimed = new Set<string>();
  readonly retryAttempts = new Map<string, RetryEntry>();
  readonly completed = new Set<string>();
  codexTotals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, runtime_ms: 0 };

  private workflow: WorkflowDefinition | null = null;
  private config: EffectiveConfig | null = null;
  private tickTimer: Timer | null = null;
  private workflowMtime = 0;
  private stopped = true;
  private agentSequence = 0;
  private tickInProgress = false;
  private currentTickStartedAt: number | null = null;
  private nextTickDueAt: number | null = null;
  private lastTickStartedAt: number | null = null;
  private lastTickCompletedAt: number | null = null;
  private lastTickError: string | null = null;
  private lastTickCandidateCount = 0;
  private lastTickDispatchedCount = 0;
  private readonly workspaceManager = new WorkspaceManager();
  private readonly agentRunner = new AgentRunner();

  constructor(
    private readonly store: KanbanStore,
    private readonly logger: Logger,
    private readonly workflowPath?: string,
    private readonly realtime?: RealtimeHub,
  ) {}

  async start() {
    this.stopped = false;
    await this.reloadWorkflow(true);
    await this.startupCleanup();
    this.scheduleTick(0);
  }

  stop() {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const retry of this.retryAttempts.values()) clearTimeout(retry.timer_handle);
    for (const running of this.running.values()) {
      running.abort.abort();
      running.process?.kill();
      this.recordRunEvent(
        running,
        "warn",
        "run_canceled",
        "Run canceled because orchestrator stopped",
      );
      this.store.updateAgentRun(running.run_id, {
        status: "CanceledByReconciliation",
        summary: "Run canceled because orchestrator stopped.",
        runtime_ms: Date.now() - running.started_at,
        finished_at: new Date().toISOString(),
      });
    }
  }

  cancelRun(id: string, reason = "Run canceled") {
    const running = [...this.running.values()].find(
      (entry) => entry.run_id === id || entry.issue.id === id,
    );
    if (!running) return false;
    running.status = "CanceledByReconciliation";
    running.abort.abort();
    running.process?.kill();
    this.recordRunEvent(running, "warn", "run_canceled", reason);
    return true;
  }

  requestTick() {
    this.scheduleTick(0);
  }

  status() {
    return {
      scheduler: {
        stopped: this.stopped,
        tick_in_progress: this.tickInProgress,
        current_tick_started_at: this.currentTickStartedAt
          ? new Date(this.currentTickStartedAt).toISOString()
          : null,
        next_tick_due_at: this.nextTickDueAt ? new Date(this.nextTickDueAt).toISOString() : null,
        last_tick_started_at: this.lastTickStartedAt
          ? new Date(this.lastTickStartedAt).toISOString()
          : null,
        last_tick_completed_at: this.lastTickCompletedAt
          ? new Date(this.lastTickCompletedAt).toISOString()
          : null,
        last_tick_error: this.lastTickError,
        last_tick_candidate_count: this.lastTickCandidateCount,
        last_tick_dispatched_count: this.lastTickDispatchedCount,
      },
      running: [...this.running.values()].map((entry) => ({
        issue: entry.issue,
        run_id: entry.run_id,
        agent_id: entry.agent_id,
        status: entry.status,
        attempt: entry.attempt,
        workspace_path: entry.workspace_path,
        prompt_preview: entry.prompt_preview,
        command: entry.command,
        model: entry.model,
        profile: entry.profile,
        pid: entry.pid,
        started_at: new Date(entry.started_at).toISOString(),
        elapsed_ms: Date.now() - entry.started_at,
        last_codex_event: entry.last_codex_event,
        last_codex_message: entry.last_codex_message,
        last_codex_timestamp: entry.last_codex_timestamp
          ? new Date(entry.last_codex_timestamp).toISOString()
          : null,
        turn_count: entry.turn_count,
        tokens: {
          input: entry.codex_input_tokens,
          output: entry.codex_output_tokens,
          total: entry.codex_total_tokens,
        },
      })),
      claimed: [...this.claimed],
      retries: [...this.retryAttempts.values()].map((entry) => ({
        issue_id: entry.issue_id,
        identifier: entry.identifier,
        attempt: entry.attempt,
        due_at: new Date(entry.due_at_ms).toISOString(),
        error: entry.error,
      })),
      completed: [...this.completed],
      codex_totals: this.codexTotals,
      config: this.config
        ? {
            polling: this.config.polling,
            active_states: this.config.tracker.active_states,
            terminal_states: this.config.tracker.terminal_states,
            done_state: this.config.tracker.done_state,
            max_concurrent_agents: this.config.agent.max_concurrent_agents,
          }
        : null,
    };
  }

  resolvedConfig() {
    return this.config;
  }

  async workflowDocument() {
    const workflow = await loadWorkflow(this.workflowPath);
    const file = Bun.file(workflow.path);
    const stat = await file.stat();
    return {
      path: workflow.path,
      source: await file.text(),
      updatedAt: stat.mtime.toISOString(),
      loadedAt: new Date(workflow.loaded_at).toISOString(),
    };
  }

  async saveWorkflow(source: string) {
    const current = await loadWorkflow(this.workflowPath);
    const next = parseWorkflowSource(source, current.path);
    validateDispatchConfig(resolveConfig(next));
    await Bun.write(current.path, source);
    await this.reloadWorkflow(true);
    const stat = await Bun.file(current.path).stat();
    this.logger.info("workflow_saved", { workflow_path: current.path });
    return {
      path: current.path,
      source,
      updatedAt: stat.mtime.toISOString(),
      loadedAt: new Date(Date.now()).toISOString(),
    };
  }

  async t3Projects() {
    const config = this.config ?? resolveConfig(await loadWorkflow(this.workflowPath));
    if (config.agent_plane.kind !== "t3") {
      throw new Error("T3 agent plane is not enabled for this workflow.");
    }
    const client = new T3Client(config.agent_plane);
    return {
      projects: await client.listProjects(),
      selectedProjectId: config.agent_plane.project_id,
    };
  }

  async createT3Project(input: { title: string; workspaceRoot: string }) {
    const config = this.config ?? resolveConfig(await loadWorkflow(this.workflowPath));
    if (config.agent_plane.kind !== "t3") {
      throw new Error("T3 agent plane is not enabled for this workflow.");
    }
    const client = new T3Client(config.agent_plane);
    return client.createProject({
      title: input.title,
      workspaceRoot: input.workspaceRoot,
      createWorkspaceRootIfMissing: true,
    });
  }

  async selectT3Project(projectId: string | null) {
    const current = await this.workflowDocument();
    if (projectId) {
      const config = this.config ?? resolveConfig(await loadWorkflow(this.workflowPath));
      const project = await new T3Client(config.agent_plane).getProject(projectId);
      if (!project) throw new Error(`T3 project ${projectId} was not found.`);
    }
    const source = updateWorkflowSourceConfig(current.source, (config) => {
      const agentPlane = ensureObject(config, "agent_plane");
      if (projectId) agentPlane.project_id = projectId;
      else delete agentPlane.project_id;
    });
    await this.saveWorkflow(source);
    return this.t3Projects();
  }

  private async tick() {
    if (this.stopped) return;
    this.tickInProgress = true;
    this.currentTickStartedAt = Date.now();
    this.lastTickStartedAt = this.currentTickStartedAt;
    this.lastTickError = null;
    this.lastTickCandidateCount = 0;
    this.lastTickDispatchedCount = 0;
    this.logger.info("tick_started", {
      started_at: new Date(this.currentTickStartedAt).toISOString(),
    });
    try {
      await this.reloadWorkflow(false);
      await this.reconcile();
      if (!this.workflow || !this.config) return;
      validateDispatchConfig(this.config);
      const candidates = this.store
        .listByStates(this.config.tracker.active_states)
        .toSorted(sortIssues);
      this.lastTickCandidateCount = candidates.length;
      for (const issue of candidates) {
        if (!this.hasGlobalSlot() || !this.isEligible(issue)) continue;
        this.lastTickDispatchedCount += 1;
        this.dispatch(issue, null).catch((error) => {
          this.logger.error("dispatch_unhandled_error", {
            issue_id: issue.id,
            error: String(error),
          });
        });
      }
    } catch (error) {
      this.lastTickError = String(error);
      this.logger.error("tick_failed", { error: String(error) });
    } finally {
      this.tickInProgress = false;
      this.lastTickCompletedAt = Date.now();
      this.currentTickStartedAt = null;
      this.logger.info("tick_completed", {
        candidate_count: this.lastTickCandidateCount,
        dispatched_count: this.lastTickDispatchedCount,
        error: this.lastTickError,
      });
      this.scheduleTick(this.config?.polling.interval_ms ?? 30000);
    }
  }

  private async reloadWorkflow(required: boolean) {
    try {
      const workflow = await loadWorkflow(this.workflowPath);
      const stat = await Bun.file(workflow.path).stat();
      if (!required && this.workflow && stat.mtimeMs === this.workflowMtime) return;
      const config = resolveConfig(workflow);
      validateDispatchConfig(config);
      this.workflow = workflow;
      this.config = config;
      this.workflowMtime = stat.mtimeMs;
      this.logger.info("workflow_loaded", {
        workflow_path: workflow.path,
        workspace_root: config.workspace.root,
      });
    } catch (error) {
      if (required) throw error;
      this.logger.error("workflow_reload_failed", { error: String(error) });
    }
  }

  private async startupCleanup() {
    if (!this.config) return;
    for (const issue of this.store.listTerminal(this.config.tracker.terminal_states)) {
      this.logger.info("startup_terminal_workspace_retained", {
        issue_id: issue.id,
        identifier: issue.identifier,
      });
    }
  }

  private async reconcile() {
    if (!this.config) return;
    const now = Date.now();
    for (const [id, running] of this.running.entries()) {
      const since = running.last_codex_timestamp ?? running.started_at;
      if (
        this.config.codex.stall_timeout_ms > 0 &&
        now - since > this.config.codex.stall_timeout_ms
      ) {
        running.status = "Stalled";
        running.abort.abort();
        running.process?.kill();
        this.running.delete(id);
        this.scheduleRetry(running.issue, (running.attempt ?? 0) + 1, "stalled");
      }
    }

    const states = this.store.getCardsByIds([...this.running.keys()]);
    const byId = new Map(states.map((issue) => [issue.id, issue]));
    for (const [id, running] of this.running.entries()) {
      const fresh = byId.get(id);
      if (!fresh) continue;
      if (isStateIn(fresh.state, this.config.tracker.terminal_states)) {
        running.status = "CanceledByReconciliation";
        running.abort.abort();
        running.process?.kill();
        this.running.delete(id);
        this.release(id);
        this.logger.info("running_issue_terminal_retained_workspace", {
          issue_id: id,
          identifier: fresh.identifier,
          workspace_path: running.workspace_path,
        });
      } else if (isStateIn(fresh.state, this.config.tracker.active_states)) {
        running.issue = fresh;
      } else {
        running.status = "CanceledByReconciliation";
        running.abort.abort();
        running.process?.kill();
        this.running.delete(id);
        this.release(id);
        this.logger.info("running_issue_no_longer_active", {
          issue_id: id,
          identifier: fresh.identifier,
          state: fresh.state,
        });
      }
    }
  }

  private async dispatch(issue: Issue, attempt: number | null) {
    if (!this.workflow || !this.config || !this.isEligible(issue)) return;
    this.claimed.add(issue.id);
    const abort = new AbortController();
    const agentIdentity = inspectAgentCommand(this.config.codex.command);
    const agentId = this.nextAgentId();
    const run = this.store.createAgentRun({
      issue_id: issue.id,
      identifier: issue.identifier,
      agent_id: agentId,
      status: "PreparingWorkspace",
      attempt,
      command: this.config.codex.command,
      model: agentIdentity.model,
      profile: agentIdentity.profile,
    });
    const running: RunningEntry = {
      run_id: run.id,
      agent_id: agentId,
      issue,
      attempt,
      workspace_path: "",
      prompt_preview: null,
      command: this.config.codex.command,
      model: agentIdentity.model,
      profile: agentIdentity.profile,
      pid: null,
      started_at: Date.now(),
      status: "PreparingWorkspace",
      process: null,
      abort,
      last_codex_event: null,
      last_codex_timestamp: null,
      last_codex_message: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      turn_count: 0,
    };
    this.running.set(issue.id, running);
    this.recordRunEvent(
      running,
      "info",
      "agent_picked_card",
      `Picked ${issue.identifier}: ${issue.title}`,
      { state: issue.state, attempt, command: running.command },
    );
    this.logger.info("agent_picked_card", {
      agent_id: running.agent_id,
      issue_id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
      attempt,
      command: running.command,
      model: running.model,
      profile: running.profile,
    });

    const started = Date.now();
    try {
      const workspace = await this.workspaceManager.ensureWorkspace(issue, this.config);
      running.workspace_path = workspace.path;
      this.store.updateAgentRun(running.run_id, { workspace_path: workspace.path });
      const currentIssue = this.store.getCard(issue.id);
      if (currentIssue) {
        this.store.updateCard(issue.id, {
          extra_data: {
            ...currentIssue.extra_data,
            assigned_workspace_path: workspace.path,
            assigned_workspace_key: workspace.workspace_key,
            workspace_created_at: workspace.created_now
              ? new Date().toISOString()
              : currentIssue.extra_data.workspace_created_at,
          },
        });
      }
      running.status = "BuildingPrompt";
      this.store.updateAgentRun(running.run_id, { status: running.status });
      const prompt = renderTemplate(this.workflow.prompt_template, { issue, attempt });
      running.prompt_preview = prompt.slice(0, 600);
      running.turn_count += 1;
      this.logger.info("agent_launching", {
        agent_id: running.agent_id,
        issue_id: issue.id,
        identifier: issue.identifier,
        workspace_path: workspace.path,
        command: running.command,
        prompt_chars: prompt.length,
      });
      this.recordRunEvent(running, "info", "agent_launching", `Launching in ${workspace.path}`, {
        command: running.command,
        prompt_chars: prompt.length,
      });
      const result = await this.agentRunner.run(
        issue,
        prompt,
        this.config,
        workspace.path,
        running,
        (event) => {
          if (event.codex_event_type === "process.started") {
            this.store.updateAgentRun(running.run_id, {
              status: "StreamingTurn",
              pid: running.pid,
            });
          }
          this.recordRunEvent(
            running,
            "info",
            String(event.codex_event_type ?? "codex_event"),
            typeof event.message === "string" ? event.message : null,
            event,
          );
          this.logger.info("codex_event", {
            agent_id: running.agent_id,
            issue_id: issue.id,
            identifier: issue.identifier,
            ...event,
          });
        },
      );
      this.codexTotals.input_tokens += result.inputTokens;
      this.codexTotals.output_tokens += result.outputTokens;
      this.codexTotals.total_tokens += result.totalTokens;
      this.codexTotals.runtime_ms += Date.now() - started;
      this.running.delete(issue.id);

      if (result.ok) {
        running.status = "Succeeded";
        this.completed.add(issue.id);
        const moved = this.moveCompletedIssue(issue, running.agent_id);
        this.postRunResult(
          issue.id,
          running.agent_id,
          result.finalMessage || "Agent finished successfully.",
        );
        this.recordRunEvent(
          running,
          "info",
          "run_succeeded",
          result.finalMessage || "Agent finished successfully.",
          { moved_to_state: moved?.state ?? null },
        );
        this.store.updateAgentRun(running.run_id, {
          status: running.status,
          summary: result.finalMessage || "Agent finished successfully.",
          moved_to_state: moved?.state ?? null,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          total_tokens: result.totalTokens,
          runtime_ms: Date.now() - started,
          finished_at: new Date().toISOString(),
        });
        this.logger.info("run_succeeded", {
          agent_id: running.agent_id,
          issue_id: issue.id,
          identifier: issue.identifier,
          moved_to_state: moved?.state ?? null,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          total_tokens: result.totalTokens,
          runtime_ms: Date.now() - started,
        });
        this.release(issue.id);
      } else {
        running.status = result.timedOut ? "TimedOut" : "Failed";
        this.postRunResult(
          issue.id,
          running.agent_id,
          result.finalMessage || result.error || "Agent run failed.",
        );
        this.recordRunEvent(running, "error", "run_failed", result.error ?? "unknown error", {
          timedOut: result.timedOut,
        });
        this.store.updateAgentRun(running.run_id, {
          status: running.status,
          error: result.error,
          summary: result.finalMessage,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
          total_tokens: result.totalTokens,
          runtime_ms: Date.now() - started,
          finished_at: new Date().toISOString(),
        });
        this.logger.error("run_failed", {
          agent_id: running.agent_id,
          issue_id: issue.id,
          identifier: issue.identifier,
          error: result.error,
        });
        this.scheduleRetry(issue, (attempt ?? 0) + 1, result.error);
      }
    } catch (error) {
      this.running.delete(issue.id);
      const message = `Agent failed before completion: ${String(error)}`;
      this.postRunResult(issue.id, running.agent_id, message);
      this.recordRunEvent(running, "error", "run_failed", message, { error: String(error) });
      this.store.updateAgentRun(running.run_id, {
        status: "Failed",
        error: String(error),
        summary: message,
        runtime_ms: Date.now() - started,
        finished_at: new Date().toISOString(),
      });
      this.logger.error("run_failed", {
        agent_id: running.agent_id,
        issue_id: issue.id,
        identifier: issue.identifier,
        error: String(error),
      });
      this.scheduleRetry(issue, (attempt ?? 0) + 1, String(error));
    }
  }

  private nextAgentId(): string {
    this.agentSequence += 1;
    return `agent-${String(this.agentSequence).padStart(4, "0")}`;
  }

  private postRunResult(issueId: string, agentId: string, body: string | null) {
    const message = body?.trim();
    if (!message) return;
    this.store.addComment(issueId, {
      author: agentId,
      kind: "result",
      body: message,
    });
  }

  private recordRunEvent(
    running: RunningEntry,
    level: "debug" | "info" | "warn" | "error",
    eventType: string,
    message: string | null,
    data: Record<string, unknown> = {},
  ) {
    const event = this.store.addAgentEvent({
      run_id: running.run_id,
      issue_id: running.issue.id,
      agent_id: running.agent_id,
      level,
      event_type: eventType,
      message,
      data,
    });
    this.realtime?.publishRunEvent(event);
  }

  private moveCompletedIssue(issue: Issue, agentId: string): Issue | null {
    if (!this.config) return null;
    const targetState =
      this.config.tracker.state_transitions.get(normalizeState(issue.state)) ??
      this.config.tracker.done_state;
    const moved = this.store.moveCard(issue.id, targetState);
    if (moved) {
      this.logger.info("card_moved_after_agent_finish", {
        agent_id: agentId,
        issue_id: issue.id,
        identifier: issue.identifier,
        from_state: issue.state,
        to_state: targetState,
      });
    }
    return moved;
  }

  private scheduleRetry(
    issue: Issue,
    attempt: number,
    error: string | null,
    delayOverride?: number,
  ) {
    if (!this.config) return;
    const existing = this.retryAttempts.get(issue.id);
    if (existing) clearTimeout(existing.timer_handle);
    const delay =
      delayOverride ??
      Math.min(10000 * 2 ** Math.max(attempt - 1, 0), this.config.agent.max_retry_backoff_ms);
    const timer = setTimeout(
      () =>
        this.handleRetry(issue.id).catch((retryError) => {
          this.logger.error("retry_failed", { issue_id: issue.id, error: String(retryError) });
        }),
      delay,
    );
    timer.unref();
    this.retryAttempts.set(issue.id, {
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt,
      due_at_ms: Date.now() + delay,
      timer_handle: timer,
      error,
    });
    this.claimed.add(issue.id);
    this.logger.info("retry_queued", {
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt,
      delay_ms: delay,
      error,
    });
  }

  private async handleRetry(issueId: string) {
    if (!this.config) return;
    const retry = this.retryAttempts.get(issueId);
    if (!retry) return;
    this.retryAttempts.delete(issueId);
    const issue = this.store
      .listByStates(this.config.tracker.active_states)
      .find((candidate) => candidate.id === issueId);
    if (!issue) {
      this.release(issueId);
      this.logger.info("retry_released_not_active", { issue_id: issueId });
      return;
    }
    if (this.hasGlobalSlot() && this.isEligible(issue, true)) {
      await this.dispatch(issue, retry.attempt);
    } else {
      this.scheduleRetry(issue, retry.attempt + 1, "no available orchestrator slots");
    }
  }

  private isEligible(issue: Issue, retryDispatch = false): boolean {
    if (!this.config) return false;
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (!isStateIn(issue.state, this.config.tracker.active_states)) return false;
    if (isStateIn(issue.state, this.config.tracker.terminal_states)) return false;
    if (this.running.has(issue.id)) return false;
    if (!retryDispatch && this.claimed.has(issue.id)) return false;
    if (!this.hasGlobalSlot()) return false;
    if (!this.hasStateSlot(issue.state)) return false;
    if (normalizeState(issue.state) === "todo") {
      const hasBlocking = issue.blocked_by.some(
        (blocker) =>
          !blocker.state || !isStateIn(blocker.state, this.config!.tracker.terminal_states),
      );
      if (hasBlocking) return false;
    }
    return true;
  }

  private hasGlobalSlot(): boolean {
    if (!this.config) return false;
    return this.running.size < this.config.agent.max_concurrent_agents;
  }

  private hasStateSlot(state: string): boolean {
    if (!this.config) return false;
    const normalized = normalizeState(state);
    const limit =
      this.config.agent.max_concurrent_agents_by_state.get(normalized) ??
      this.config.agent.max_concurrent_agents;
    let runningInState = 0;
    for (const entry of this.running.values()) {
      if (normalizeState(entry.issue.state) === normalized) runningInState += 1;
    }
    return runningInState < limit;
  }

  private release(issueId: string) {
    this.claimed.delete(issueId);
    const retry = this.retryAttempts.get(issueId);
    if (retry) clearTimeout(retry.timer_handle);
    this.retryAttempts.delete(issueId);
  }

  private scheduleTick(delay: number) {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.nextTickDueAt = Date.now() + delay;
    this.tickTimer = setTimeout(() => void this.tick(), delay);
    this.tickTimer.unref();
  }
}

function ensureObject(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  root[key] = next;
  return next;
}

function inspectAgentCommand(command: string): { model: string | null; profile: string | null } {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return {
    model: flagValue(parts, ["-m", "--model"]),
    profile: flagValue(parts, ["-p", "--profile"]),
  };
}

function flagValue(parts: string[], names: string[]): string | null {
  for (let index = 0; index < parts.length; index += 1) {
    const part = stripQuotes(parts[index] ?? "");
    for (const name of names) {
      if (part === name) return stripQuotes(parts[index + 1] ?? "") || null;
      if (part.startsWith(`${name}=`)) return stripQuotes(part.slice(name.length + 1)) || null;
    }
  }
  return null;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function sortIssues(a: Issue, b: Issue): number {
  const priorityA = a.priority ?? Number.MAX_SAFE_INTEGER;
  const priorityB = b.priority ?? Number.MAX_SAFE_INTEGER;
  if (priorityA !== priorityB) return priorityA - priorityB;
  const created = a.created_at.localeCompare(b.created_at);
  if (created !== 0) return created;
  return a.identifier.localeCompare(b.identifier);
}
