import { T3Client, type T3Thread } from "./t3-client";
import type { AgentRunResult, EffectiveConfig, Issue, RunningEntry } from "./types";

export class T3AgentPlane {
  async run(
    issue: Issue,
    prompt: string,
    config: EffectiveConfig,
    workspacePath: string,
    running: RunningEntry,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<AgentRunResult> {
    const client = new T3Client(config.agent_plane);
    const threadId = `symphony-run-${running.run_id}`;
    const title =
      `${issue.identifier} ${issue.title}`.trim().slice(0, 160) || issue.title || issue.identifier;

    running.status = "LaunchingAgentProcess";
    onEvent?.({
      codex_event_type: "t3.project.ensure",
      message: config.agent_plane.project_id
        ? "Loading selected T3 project"
        : "Ensuring T3 project",
      provider: "t3",
    });
    const project = config.agent_plane.project_id
      ? await client.getProject(config.agent_plane.project_id)
      : await client.ensureProject(workspacePath, title);
    if (!project) {
      throw new Error(`Configured T3 project ${config.agent_plane.project_id} was not found.`);
    }
    onEvent?.({
      codex_event_type: "t3.project.ready",
      message: `T3 project ${project.id}`,
      provider: "t3",
      provider_event: { kind: "project", project },
    });

    const abortHandler = () => void client.interruptThread(threadId).catch(() => undefined);
    running.abort.signal.addEventListener("abort", abortHandler, { once: true });

    try {
      onEvent?.({
        codex_event_type: "t3.turn.starting",
        message: `Starting T3 thread ${threadId}`,
        provider: "t3",
        thread_id: threadId,
      });
      await client.startTurn({ threadId, projectId: project.id, title, prompt, workspacePath });
      running.status = "StreamingTurn";
      onEvent?.({
        codex_event_type: "t3.turn.started",
        message: `T3 thread ${threadId}`,
        provider: "t3",
        thread_id: threadId,
      });

      const result = await client.waitForTurn({
        threadId,
        timeoutMs: config.codex.turn_timeout_ms,
        abortSignal: running.abort.signal,
        onThread: (thread, snapshot) => {
          const summary = summarizeT3Thread(thread);
          running.last_codex_timestamp = Date.now();
          running.last_codex_event = summary.codex_event_type;
          if (summary.message) running.last_codex_message = summary.message;
          onEvent?.({
            ...summary,
            provider: "t3",
            thread_id: threadId,
            provider_event: {
              kind: "thread.snapshot",
              thread,
              snapshotSequence: snapshot.snapshotSequence,
              updatedAt: snapshot.updatedAt,
            },
          });
        },
      });

      return {
        ok: result.ok,
        timedOut: result.timedOut,
        error: result.error,
        finalMessage: result.finalMessage,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
    } finally {
      running.abort.signal.removeEventListener("abort", abortHandler);
    }
  }
}

function summarizeT3Thread(thread: T3Thread) {
  const state = thread.latestTurn?.state ?? thread.session?.status ?? "unknown";
  const last = thread.messages.toReversed().find((message) => message.role === "assistant");
  return {
    codex_event_type: `t3.thread.${state}`,
    message: last?.text?.slice(0, 500) ?? `T3 thread ${state}`,
    finalMessage: state === "completed" ? (last?.text?.slice(0, 500) ?? null) : null,
    error: state === "error" ? (thread.session?.lastError ?? "T3 thread error") : null,
    tokens: null,
  };
}
