import { runHook } from "./workspace";
import type { AgentRunResult, EffectiveConfig, Issue, RunningEntry } from "./types";
import {
  createAgentSession,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { createAgentPlane } from "./agent-plane";

type AgentOutputFormat = EffectiveConfig["codex"]["output_format"];
type UsageSummary = { inputTokens: number; outputTokens: number; totalTokens: number };
type OutputSummary = {
  codex_event_type: string;
  message: string | null;
  tokens: UsageSummary | null;
  finalMessage: string | null;
  error: string | null;
};

export type { AgentRunResult } from "./types";

export class AgentRunner {
  async run(
    issue: Issue,
    prompt: string,
    config: EffectiveConfig,
    workspacePath: string,
    running: RunningEntry,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<AgentRunResult> {
    if (config.hooks.before_run)
      await runHook(config.hooks.before_run, workspacePath, config.hooks.timeout_ms);
    const agentPlane = createAgentPlane(config);
    if (agentPlane) {
      const result = await agentPlane.run(issue, prompt, config, workspacePath, running, onEvent);
      if (config.hooks.after_run) {
        try {
          await runHook(config.hooks.after_run, workspacePath, config.hooks.timeout_ms);
        } catch {
          // Per spec, after_run failures are logged by the orchestrator path and ignored for outcome.
        }
      }
      return result;
    }
    if (config.codex.backend === "pi-sdk") {
      return this.runPiSdk(prompt, config, workspacePath, running, onEvent);
    }

    running.status = "LaunchingAgentProcess";
    const proc = Bun.spawn(["bash", "-lc", config.codex.command], {
      cwd: workspacePath,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: running.abort.signal,
    });
    running.process = proc;
    running.pid = proc.pid;
    onEvent?.({ codex_event_type: "process.started", message: `pid ${proc.pid}` });
    running.status = "StreamingTurn";

    proc.stdin.write(prompt);
    proc.stdin.end();

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      running.status = "TimedOut";
      proc.kill();
    }, config.codex.turn_timeout_ms);
    timeout.unref();

    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let outputError: string | null = null;
    const stderrPromise = new Response(proc.stderr).text();
    const outputPromise = this.consumeStdout(
      proc.stdout,
      running,
      (usage) => {
        inputTokens = Math.max(inputTokens, usage.inputTokens);
        outputTokens = Math.max(outputTokens, usage.outputTokens);
        totalTokens = Math.max(totalTokens, usage.totalTokens);
      },
      (error) => {
        outputError = error;
      },
      config.codex.output_format,
      onEvent,
    );

    const exitCode = await proc.exited;
    clearTimeout(timeout);
    await outputPromise;
    const stderr = await stderrPromise;

    running.codex_input_tokens = inputTokens;
    running.codex_output_tokens = outputTokens;
    running.codex_total_tokens = totalTokens;

    const ok = exitCode === 0 && !timedOut && !running.abort.signal.aborted && !outputError;

    if (config.hooks.after_run) {
      try {
        await runHook(config.hooks.after_run, workspacePath, config.hooks.timeout_ms);
      } catch {
        // Per spec, after_run failures are logged by the orchestrator path and ignored for outcome.
      }
    }

    return {
      ok,
      timedOut,
      error: ok ? null : outputError || stderr.trim() || `Agent exited with code ${exitCode}`,
      finalMessage: running.last_codex_message,
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }

  private async runPiSdk(
    prompt: string,
    config: EffectiveConfig,
    workspacePath: string,
    running: RunningEntry,
    onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<AgentRunResult> {
    running.status = "LaunchingAgentProcess";
    onEvent?.({ codex_event_type: "pi.sdk.started", message: "Pi SDK session starting" });

    let timedOut = false;
    let outputError: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
    let unsubscribe: (() => void) | null = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      running.status = "TimedOut";
      void session?.abort();
    }, config.codex.turn_timeout_ms);
    timeout.unref();

    const abortHandler = () => {
      void session?.abort();
    };
    running.abort.signal.addEventListener("abort", abortHandler, { once: true });

    try {
      const created = await createAgentSession({
        cwd: workspacePath,
        sessionManager: SessionManager.create(workspacePath),
      });
      session = created.session;
      running.status = "StreamingTurn";
      onEvent?.({
        codex_event_type: "pi.sdk.session",
        message: `Pi session ${session.sessionId}`,
        session_id: session.sessionId,
        session_file: session.sessionFile ?? null,
        model: session.model ? `${session.model.provider}/${session.model.id}` : null,
        thinking_level: session.thinkingLevel,
      });

      unsubscribe = session.subscribe((event) => {
        running.last_codex_timestamp = Date.now();
        const summary = summarizePiSdkEvent(event);
        running.last_codex_event = summary.codex_event_type;
        if (summary.tokens) {
          inputTokens = Math.max(inputTokens, summary.tokens.inputTokens);
          outputTokens = Math.max(outputTokens, summary.tokens.outputTokens);
          totalTokens = Math.max(totalTokens, summary.tokens.totalTokens);
        }
        if (summary.finalMessage) running.last_codex_message = summary.finalMessage;
        else if (summary.message) running.last_codex_message = summary.message;
        if (summary.error) outputError = summary.error;
        onEvent?.({ ...summary, pi_event: event });
      });

      await session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" });
      if (session.model) {
        running.model = `${session.model.provider}/${session.model.id}`;
      }
    } catch (error) {
      outputError = outputError ?? String(error);
    } finally {
      clearTimeout(timeout);
      running.abort.signal.removeEventListener("abort", abortHandler);
      unsubscribe?.();
      session?.dispose();
    }

    running.codex_input_tokens = inputTokens;
    running.codex_output_tokens = outputTokens;
    running.codex_total_tokens = totalTokens;

    if (config.hooks.after_run) {
      try {
        await runHook(config.hooks.after_run, workspacePath, config.hooks.timeout_ms);
      } catch {
        // Per spec, after_run failures are logged by the orchestrator path and ignored for outcome.
      }
    }

    const ok = !timedOut && !running.abort.signal.aborted && !outputError;
    return {
      ok,
      timedOut,
      error: ok ? null : outputError || (timedOut ? "Pi SDK run timed out" : "Pi SDK run failed"),
      finalMessage: running.last_codex_message,
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }

  private async consumeStdout(
    stream: ReadableStream<Uint8Array>,
    running: RunningEntry,
    onUsage: (usage: UsageSummary) => void,
    onOutputError: (error: string) => void,
    outputFormat: AgentOutputFormat,
    onEvent?: (event: Record<string, unknown>) => void,
  ) {
    const reader = stream
      .pipeThrough(new TextDecoderStream() as TransformStream<Uint8Array, string>)
      .getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) this.recordLine(line, running, onUsage, onOutputError, outputFormat, onEvent);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim())
      this.recordLine(buffer.trim(), running, onUsage, onOutputError, outputFormat, onEvent);
  }

  private recordLine(
    line: string,
    running: RunningEntry,
    onUsage: (usage: UsageSummary) => void,
    onOutputError: (error: string) => void,
    outputFormat: AgentOutputFormat,
    onEvent?: (event: Record<string, unknown>) => void,
  ) {
    running.last_codex_timestamp = Date.now();
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      running.last_codex_event = typeof event.type === "string" ? event.type : "json";
      const summary = summarizeAgentEvent(event, outputFormat);
      if (summary.tokens) onUsage(summary.tokens);
      if (summary.finalMessage) running.last_codex_message = summary.finalMessage;
      else if (summary.message) running.last_codex_message = summary.message;
      if (summary.error) onOutputError(summary.error);
      onEvent?.(summary);
    } catch {
      running.last_codex_event = "text";
      running.last_codex_message = line.slice(0, 500);
      onEvent?.({ codex_event_type: "text", message: line.slice(0, 500) });
    }
  }
}

function summarizePiSdkEvent(event: AgentSessionEvent): OutputSummary {
  const record = event as unknown as Record<string, unknown>;
  if (event.type === "message_update") {
    return summarizePiEvent({
      type: event.type,
      assistantMessageEvent: event.assistantMessageEvent,
      message: event.message,
    });
  }
  if (event.type === "message_end" || event.type === "turn_end") {
    return summarizePiEvent({ type: event.type, message: event.message });
  }
  if (event.type === "agent_end") {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const assistantMessage = messages
      .toReversed()
      .find((message) => objectValue(message)?.role === "assistant");
    return summarizePiEvent({ type: event.type, assistantMessage });
  }
  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  ) {
    return {
      codex_event_type: `pi.${event.type}`,
      message: summarizePiToolEvent(record),
      finalMessage: null,
      error:
        event.type === "tool_execution_end" && record.isError === true
          ? summarizePiToolEvent(record)
          : null,
      tokens: null,
    };
  }
  if (event.type === "compaction_end" && event.errorMessage) {
    return {
      codex_event_type: "pi.compaction_end",
      message: event.errorMessage,
      finalMessage: null,
      error: event.errorMessage,
      tokens: null,
    };
  }
  return {
    codex_event_type: `pi.${event.type}`,
    message: stringValue(record.message) ?? stringValue(record.errorMessage) ?? null,
    finalMessage: null,
    error: null,
    tokens: null,
  };
}

function summarizePiToolEvent(event: Record<string, unknown>): string | null {
  const toolName = stringValue(event.toolName) ?? "tool";
  if (event.type === "tool_execution_start") return `${toolName} started`;
  if (event.type === "tool_execution_update") return `${toolName} updated`;
  if (event.type === "tool_execution_end")
    return `${toolName} ${event.isError === true ? "failed" : "finished"}`;
  return null;
}

export function summarizeAgentEvent(
  event: Record<string, unknown>,
  outputFormat: AgentOutputFormat,
): OutputSummary {
  if (outputFormat === "pi-json") return summarizePiEvent(event);
  return summarizeCodexEvent(event);
}

function summarizeCodexEvent(event: Record<string, unknown>): OutputSummary {
  const usage = findUsage(event);
  const message =
    stringValue(event.message) ||
    stringValue(event.text) ||
    stringValue(event.delta) ||
    summarizeNestedMessage(event);
  return {
    codex_event_type: typeof event.type === "string" ? event.type : "json",
    message: message?.slice(0, 500) ?? null,
    finalMessage: null,
    error: null,
    tokens: usage,
  };
}

function summarizePiEvent(event: Record<string, unknown>): OutputSummary {
  const eventType = typeof event.type === "string" ? event.type : "json";
  const assistantEvent =
    objectValue(event.assistantMessageEvent) ??
    objectValue(objectValue(event.message_update)?.assistantMessageEvent);
  const message = summarizePiMessage(event, assistantEvent);
  const finalMessage = eventType === "message_end" || eventType === "agent_end" ? message : null;
  const stopReason = findPiStopReason(event);
  const error =
    stopReason === "error" || stopReason === "aborted" ? piErrorMessage(event, stopReason) : null;
  const usage = findPiUsage(event) ?? findUsage(event);
  return {
    codex_event_type: `pi.${eventType}`,
    message: message?.slice(0, 500) ?? null,
    finalMessage: finalMessage?.slice(0, 500) ?? null,
    error,
    tokens: usage,
  };
}

function summarizePiMessage(
  event: Record<string, unknown>,
  assistantEvent: Record<string, unknown> | null,
): string | null {
  if (assistantEvent?.type === "text_delta") {
    return (
      stringValue(assistantEvent.text_delta) ||
      stringValue(assistantEvent.textDelta) ||
      stringValue(assistantEvent.delta) ||
      stringValue(assistantEvent.text)
    );
  }
  return (
    stringValue(event.message) ||
    stringValue(event.text) ||
    stringValue(event.delta) ||
    summarizePiAssistantMessage(event) ||
    summarizeNestedMessage(event)
  );
}

function summarizePiAssistantMessage(event: Record<string, unknown>): string | null {
  const message =
    objectValue(event.assistantMessage) ??
    objectValue(event.message) ??
    objectValue(event.assistant_message);
  if (!message) return null;
  return (
    stringValue(message.text) || stringValue(message.content) || textFromContent(message.content)
  );
}

function findPiUsage(event: Record<string, unknown>): UsageSummary | null {
  const assistant =
    objectValue(event.assistantMessage) ??
    objectValue(event.message) ??
    objectValue(event.assistant_message);
  const usage = objectValue(assistant?.usage) ?? objectValue(event.usage);
  if (!usage) return null;
  const inputTokens =
    numberValue(usage.input_tokens) ||
    numberValue(usage.inputTokens) ||
    numberValue(usage.input) ||
    numberValue(usage.prompt_tokens);
  const outputTokens =
    numberValue(usage.output_tokens) ||
    numberValue(usage.outputTokens) ||
    numberValue(usage.output) ||
    numberValue(usage.completion_tokens);
  const totalTokens =
    numberValue(usage.total_tokens) || numberValue(usage.totalTokens) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function findPiStopReason(event: Record<string, unknown>): string | null {
  const assistant =
    objectValue(event.assistantMessage) ??
    objectValue(event.message) ??
    objectValue(event.assistant_message);
  return (
    stringValue(event.stopReason) ||
    stringValue(event.stop_reason) ||
    stringValue(assistant?.stopReason) ||
    stringValue(assistant?.stop_reason)
  );
}

function piErrorMessage(event: Record<string, unknown>, stopReason: string): string {
  const assistant =
    objectValue(event.assistantMessage) ??
    objectValue(event.message) ??
    objectValue(event.assistant_message);
  return (
    stringValue(event.error) ||
    stringValue(event.message) ||
    stringValue(assistant?.error) ||
    stringValue(assistant?.message) ||
    `Pi assistant stopped with ${stopReason}`
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textFromContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value
    .map((item) => objectValue(item))
    .map((item) => stringValue(item?.text) || stringValue(item?.content))
    .filter((item): item is string => Boolean(item));
  return parts.length ? parts.join("") : null;
}

function summarizeNestedMessage(event: Record<string, unknown>): string | null {
  const item = event.item;
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    return stringValue(record.text) || stringValue(record.message) || stringValue(record.content);
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function findUsage(event: Record<string, unknown>) {
  const usage = event.usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const inputTokens = numberValue(record.input_tokens);
  const outputTokens = numberValue(record.output_tokens);
  const totalTokens = numberValue(record.total_tokens) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
