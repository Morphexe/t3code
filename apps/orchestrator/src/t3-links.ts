import type { AgentRun, AgentRunEvent, EffectiveConfig } from "./types";

const DEFAULT_T3_ENVIRONMENT_ID = "environment-local";

export type T3RunLinks = {
  threadId: string;
  chatUrl: string;
  embedUrl: string;
};

export type AgentRunWithT3Links = AgentRun & {
  t3_thread_id: string | null;
  t3_chat_url: string | null;
  t3_embed_url: string | null;
};

export function enrichRunWithT3Links(
  run: AgentRun,
  config: EffectiveConfig | null,
): AgentRunWithT3Links {
  const links = t3LinksForRun(run, config);
  return {
    ...run,
    t3_thread_id: links?.threadId ?? null,
    t3_chat_url: links?.chatUrl ?? null,
    t3_embed_url: links?.embedUrl ?? null,
  };
}

export function t3LinksForRun(run: AgentRun, config: EffectiveConfig | null): T3RunLinks | null {
  if (config?.agent_plane.kind !== "t3") return null;

  const threadId = latestT3ThreadId(run.events);
  if (!threadId) return null;

  return buildT3RunLinks(config.agent_plane.base_url, threadId);
}

export function latestT3ThreadId(events: readonly AgentRunEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    const threadId = stringValue(event.data.thread_id) ?? threadIdFromProviderEvent(event.data);
    if (threadId) return threadId;
  }
  return null;
}

export function buildT3RunLinks(baseUrl: string, threadId: string): T3RunLinks | null {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) return null;

  const root = baseUrl.trim();
  if (!root) return null;

  const chatUrl = new URL(
    `/${DEFAULT_T3_ENVIRONMENT_ID}/${encodeURIComponent(normalizedThreadId)}`,
    root.endsWith("/") ? root : `${root}/`,
  );
  const embedUrl = new URL(chatUrl);
  embedUrl.searchParams.set("embed", "1");

  return {
    threadId: normalizedThreadId,
    chatUrl: chatUrl.toString(),
    embedUrl: embedUrl.toString(),
  };
}

function threadIdFromProviderEvent(data: Record<string, unknown>): string | null {
  const providerEvent = data.provider_event;
  if (!providerEvent || typeof providerEvent !== "object") return null;
  const providerRecord = providerEvent as Record<string, unknown>;
  return stringValue(providerRecord.thread_id) ?? threadIdFromThreadSnapshot(providerRecord.thread);
}

function threadIdFromThreadSnapshot(thread: unknown): string | null {
  if (!thread || typeof thread !== "object") return null;
  return stringValue((thread as Record<string, unknown>).id);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
