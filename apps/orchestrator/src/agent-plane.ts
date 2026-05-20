import { T3AgentPlane } from "./t3-agent-plane";
import type { AgentRunResult, EffectiveConfig, Issue, RunningEntry } from "./types";

export type AgentPlaneEventHandler = (event: Record<string, unknown>) => void;

export interface AgentPlane {
  run(
    issue: Issue,
    prompt: string,
    config: EffectiveConfig,
    workspacePath: string,
    running: RunningEntry,
    onEvent?: AgentPlaneEventHandler,
  ): Promise<AgentRunResult>;
}

export function createAgentPlane(config: EffectiveConfig): AgentPlane | null {
  if (config.agent_plane.kind === "t3") return new T3AgentPlane();
  return null;
}
