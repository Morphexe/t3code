import os from "node:os";
import path from "node:path";
import type { EffectiveConfig, WorkflowDefinition } from "./types";

export class ConfigError extends Error {}

let embeddedT3AuthToken: string | null = null;

export function resolveConfig(definition: WorkflowDefinition): EffectiveConfig {
  const raw = definition.config;
  const workflowDir = path.dirname(definition.path);
  const tracker = objectAt(raw, "tracker");
  const polling = objectAt(raw, "polling");
  const workspace = objectAt(raw, "workspace");
  const hooks = objectAt(raw, "hooks");
  const agent = objectAt(raw, "agent");
  const codex = objectAt(raw, "codex");
  const agentPlane = objectAt(raw, "agent_plane");
  const agentPlaneKind = agentPlaneKindAt(agentPlane, "kind", "legacy");
  const configuredAgentPlaneAuthToken = stringAt(
    agentPlane,
    "auth_token",
    process.env[stringAt(agentPlane, "auth_token_env", "T3CODE_AUTH_TOKEN")] ?? "",
  );

  const kind = stringAt(tracker, "kind", "kanban");
  if (kind !== "kanban") {
    throw new ConfigError(
      `Unsupported tracker.kind "${kind}". This implementation supports "kanban".`,
    );
  }

  const rootRaw = stringAt(workspace, "root", "./workspaces");
  const root = resolvePath(rootRaw, workflowDir);
  const seedFromRaw = nullableStringAt(workspace, "seed_from");

  return {
    workflow_path: definition.path,
    workflow_dir: workflowDir,
    tracker: {
      kind: "kanban",
      active_states: stringListAt(tracker, "active_states", ["Todo", "In Progress"]),
      terminal_states: stringListAt(tracker, "terminal_states", [
        "Done",
        "Closed",
        "Cancelled",
        "Canceled",
        "Duplicate",
      ]),
      done_state: stringAt(tracker, "done_state", "Done"),
      state_transitions: stateTransitionMap(tracker.state_transitions),
    },
    polling: {
      interval_ms: positiveIntAt(polling, "interval_ms", 30000),
    },
    workspace: {
      root,
      seed_from: seedFromRaw ? resolvePath(seedFromRaw, workflowDir) : null,
      mode: workspaceModeAt(workspace, "mode", "auto"),
    },
    hooks: {
      after_create: nullableStringAt(hooks, "after_create"),
      before_run: nullableStringAt(hooks, "before_run"),
      after_run: nullableStringAt(hooks, "after_run"),
      before_remove: nullableStringAt(hooks, "before_remove"),
      timeout_ms: positiveIntAt(hooks, "timeout_ms", 60000),
    },
    agent: {
      max_concurrent_agents: positiveIntAt(agent, "max_concurrent_agents", 10),
      max_turns: positiveIntAt(agent, "max_turns", 20),
      max_retry_backoff_ms: positiveIntAt(agent, "max_retry_backoff_ms", 300000),
      max_concurrent_agents_by_state: concurrencyMap(agent.max_concurrent_agents_by_state),
    },
    agent_plane: {
      kind: agentPlaneKind,
      base_url: stringAt(
        agentPlane,
        "base_url",
        process.env.T3CODE_BASE_URL ?? `http://localhost:${process.env.T3CODE_PORT ?? "3002"}`,
      ),
      auth_token:
        configuredAgentPlaneAuthToken ||
        (agentPlaneKind === "t3" ? issueEmbeddedT3AuthToken() : ""),
      provider_instance: stringAt(
        agentPlane,
        "provider_instance",
        process.env.T3CODE_PROVIDER_INSTANCE ?? "codex",
      ),
      project_id: nullableStringAt(agentPlane, "project_id"),
      model: stringAt(agentPlane, "model", "gpt-5.5"),
      runtime_mode: t3RuntimeModeAt(agentPlane, "runtime_mode", "full-access"),
      interaction_mode: t3InteractionModeAt(agentPlane, "interaction_mode", "default"),
      poll_interval_ms: positiveIntAt(agentPlane, "poll_interval_ms", 1000),
    },
    codex: {
      backend: backendAt(codex, "backend", "cli"),
      command: stringAt(
        codex,
        "command",
        "codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -",
      ),
      output_format: outputFormatAt(codex, "output_format", "codex-json"),
      approval_policy: codex.approval_policy,
      thread_sandbox: codex.thread_sandbox,
      turn_sandbox_policy: codex.turn_sandbox_policy,
      turn_timeout_ms: positiveIntAt(codex, "turn_timeout_ms", 3600000),
      read_timeout_ms: positiveIntAt(codex, "read_timeout_ms", 5000),
      stall_timeout_ms: intAt(codex, "stall_timeout_ms", 300000),
    },
  };
}

function issueEmbeddedT3AuthToken() {
  if (process.env.T3CODE_ORCHESTRATOR_EMBEDDED !== "1") return "";
  if (embeddedT3AuthToken) return embeddedT3AuthToken;
  const baseDir = process.env.T3CODE_HOME?.trim();
  const devUrl = process.env.VITE_DEV_SERVER_URL?.trim();
  if (!baseDir || !devUrl) {
    throw new ConfigError(
      "T3CODE_HOME and VITE_DEV_SERVER_URL are required for embedded T3 orchestration auth.",
    );
  }

  const serverBin = path.resolve(import.meta.dirname, "../../server/src/bin.ts");
  const issued = Bun.spawnSync({
    cmd: [
      process.env.NODE ?? "node",
      serverBin,
      "auth",
      "session",
      "issue",
      "--base-dir",
      baseDir,
      "--dev-url",
      devUrl,
      "--role",
      "owner",
      "--subject",
      "orchestrator-dev",
      "--label",
      "Orchestrator dev bridge",
      "--token-only",
    ],
    env: process.env,
  });
  const stdout = new TextDecoder().decode(issued.stdout).trim();
  const stderr = new TextDecoder().decode(issued.stderr).trim();
  if (issued.exitCode !== 0 || !stdout) {
    throw new ConfigError(
      `Failed to issue embedded T3 auth token: ${stderr || stdout || `exit ${issued.exitCode}`}`,
    );
  }
  embeddedT3AuthToken = stdout;
  return stdout;
}

export function validateDispatchConfig(config: EffectiveConfig) {
  if (config.agent_plane.kind === "t3") {
    if (!config.agent_plane.base_url.trim())
      throw new ConfigError("agent_plane.base_url is required for T3 backend");
    if (!config.agent_plane.provider_instance.trim())
      throw new ConfigError("agent_plane.provider_instance is required for T3 backend");
    if (!config.agent_plane.model.trim())
      throw new ConfigError("agent_plane.model is required for T3 backend");
  }
  if (
    config.agent_plane.kind === "legacy" &&
    config.codex.backend === "cli" &&
    !config.codex.command.trim()
  )
    throw new ConfigError("codex.command is required for cli backend");
  if (config.tracker.kind !== "kanban") throw new ConfigError("tracker.kind must be kanban");
}

function resolvePath(value: string, baseDir: string): string {
  const envExpanded = value.replace(
    /^\$([A-Za-z_][A-Za-z0-9_]*)$/,
    (_, name: string) => process.env[name] ?? "",
  );
  const homeExpanded = envExpanded.startsWith("~/")
    ? path.join(os.homedir(), envExpanded.slice(2))
    : envExpanded;
  return path.resolve(
    path.isAbsolute(homeExpanded) ? homeExpanded : path.join(baseDir, homeExpanded),
  );
}

function objectAt(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringAt(root: Record<string, unknown>, key: string, fallback: string): string {
  const value = root[key];
  if (typeof value === "string") {
    if (value.startsWith("$")) return process.env[value.slice(1)] || "";
    return value;
  }
  return fallback;
}

function nullableStringAt(root: Record<string, unknown>, key: string): string | null {
  const value = root[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function workspaceModeAt(
  root: Record<string, unknown>,
  key: string,
  fallback: "auto" | "copy" | "git_worktree",
) {
  const value = root[key];
  if (value === "auto" || value === "copy" || value === "git_worktree") return value;
  return fallback;
}

function outputFormatAt(
  root: Record<string, unknown>,
  key: string,
  fallback: "codex-json" | "pi-json",
) {
  const value = root[key];
  if (value === "codex-json" || value === "pi-json") return value;
  return fallback;
}

function backendAt(root: Record<string, unknown>, key: string, fallback: "cli" | "pi-sdk") {
  const value = root[key];
  if (value === "cli" || value === "pi-sdk") return value;
  return fallback;
}

function agentPlaneKindAt(root: Record<string, unknown>, key: string, fallback: "legacy" | "t3") {
  const value = root[key];
  if (value === "legacy" || value === "t3") return value;
  return fallback;
}

function t3RuntimeModeAt(
  root: Record<string, unknown>,
  key: string,
  fallback: "approval-required" | "auto-accept-edits" | "full-access",
) {
  const value = root[key];
  if (value === "approval-required" || value === "auto-accept-edits" || value === "full-access")
    return value;
  return fallback;
}

function t3InteractionModeAt(
  root: Record<string, unknown>,
  key: string,
  fallback: "default" | "plan",
) {
  const value = root[key];
  if (value === "default" || value === "plan") return value;
  return fallback;
}

function stringListAt(root: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = root[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : fallback;
}

function intAt(root: Record<string, unknown>, key: string, fallback: number): number {
  const value = root[key];
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function positiveIntAt(root: Record<string, unknown>, key: string, fallback: number): number {
  const value = intAt(root, key, fallback);
  if (value <= 0) throw new ConfigError(`${key} must be a positive integer`);
  return value;
}

function concurrencyMap(value: unknown): Map<string, number> {
  const map = new Map<string, number>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return map;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
      map.set(key.toLowerCase(), raw);
    }
  }
  return map;
}

function stateTransitionMap(value: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return map;
  for (const [from, to] of Object.entries(value)) {
    if (typeof to === "string" && to.trim()) map.set(from.toLowerCase(), to);
  }
  return map;
}
