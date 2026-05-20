import { describe, expect, test } from "vitest";
import { buildT3RunLinks, latestT3ThreadId } from "../src/t3-links";
import type { AgentRunEvent } from "../src/types";

describe("T3 run links", () => {
  test("builds chat and embed URLs for a T3 thread", () => {
    expect(buildT3RunLinks("http://localhost:3002", "thread-123")).toEqual({
      threadId: "thread-123",
      chatUrl: "http://localhost:3002/environment-local/thread-123",
      embedUrl: "http://localhost:3002/environment-local/thread-123?embed=1",
    });
  });

  test("extracts the latest T3 thread id from run events", () => {
    expect(
      latestT3ThreadId([
        event({ thread_id: "thread-old" }),
        event({ provider_event: { thread: { id: "thread-new" } } }),
      ]),
    ).toBe("thread-new");
  });
});

function event(data: Record<string, unknown>): AgentRunEvent {
  return {
    id: crypto.randomUUID(),
    run_id: "run-1",
    issue_id: "card-1",
    agent_id: "agent-1",
    level: "info",
    event_type: "t3.thread.completed",
    message: null,
    data,
    created_at: new Date().toISOString(),
  };
}
