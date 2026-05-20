export type BlockerRef = {
  id: string | null;
  identifier: string | null;
  state: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type Issue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  position: number;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  comments: IssueComment[];
  comment_count: number;
  extra_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type IssueComment = {
  id: string;
  issue_id: string;
  author: string;
  body: string;
  kind: "comment" | "planning" | "agent" | "result";
  created_at: string;
};

export type AgentRun = {
  id: string;
  issue_id: string;
  identifier: string;
  agent_id: string;
  status: RunStatus;
  attempt: number | null;
  command: string;
  model: string | null;
  profile: string | null;
  workspace_path: string | null;
  workspace_exists: boolean;
  pid: number | null;
  summary: string | null;
  error: string | null;
  moved_to_state: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  runtime_ms: number;
  started_at: string;
  finished_at: string | null;
  events: AgentRunEvent[];
};

export type AgentRunResult = {
  ok: boolean;
  timedOut: boolean;
  error: string | null;
  finalMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AgentRunEvent = {
  id: string;
  run_id: string;
  issue_id: string;
  agent_id: string;
  level: "debug" | "info" | "warn" | "error";
  event_type: string;
  message: string | null;
  data: Record<string, unknown>;
  created_at: string;
};

export type WorkflowDefinition = {
  path: string;
  config: Record<string, unknown>;
  prompt_template: string;
  loaded_at: number;
};

export type HookConfig = {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
};

export type EffectiveConfig = {
  workflow_path: string;
  workflow_dir: string;
  tracker: {
    kind: "kanban";
    active_states: string[];
    terminal_states: string[];
    done_state: string;
    state_transitions: Map<string, string>;
  };
  polling: {
    interval_ms: number;
  };
  workspace: {
    root: string;
    seed_from: string | null;
    mode: "auto" | "copy" | "git_worktree";
  };
  hooks: HookConfig;
  agent: {
    max_concurrent_agents: number;
    max_turns: number;
    max_retry_backoff_ms: number;
    max_concurrent_agents_by_state: Map<string, number>;
  };
  agent_plane: {
    kind: "legacy" | "t3";
    base_url: string;
    auth_token: string;
    provider_instance: string;
    project_id: string | null;
    model: string;
    runtime_mode: "approval-required" | "auto-accept-edits" | "full-access";
    interaction_mode: "default" | "plan";
    poll_interval_ms: number;
  };
  codex: {
    backend: "cli" | "pi-sdk";
    command: string;
    output_format: "codex-json" | "pi-json";
    approval_policy: unknown;
    thread_sandbox: unknown;
    turn_sandbox_policy: unknown;
    turn_timeout_ms: number;
    read_timeout_ms: number;
    stall_timeout_ms: number;
  };
};

export type Workspace = {
  path: string;
  workspace_key: string;
  created_now: boolean;
};

export type RunningEntry = {
  run_id: string;
  agent_id: string;
  issue: Issue;
  attempt: number | null;
  workspace_path: string;
  prompt_preview: string | null;
  command: string;
  model: string | null;
  profile: string | null;
  pid: number | null;
  started_at: number;
  status: RunStatus;
  process: Bun.Subprocess<"pipe", "pipe", "pipe"> | null;
  abort: AbortController;
  last_codex_event: string | null;
  last_codex_timestamp: number | null;
  last_codex_message: string | null;
  codex_input_tokens: number;
  codex_output_tokens: number;
  codex_total_tokens: number;
  turn_count: number;
};

export type RetryEntry = {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: Timer;
  error: string | null;
};

export type RunStatus =
  | "PreparingWorkspace"
  | "BuildingPrompt"
  | "LaunchingAgentProcess"
  | "StreamingTurn"
  | "Finishing"
  | "Succeeded"
  | "Failed"
  | "TimedOut"
  | "Stalled"
  | "CanceledByReconciliation";
