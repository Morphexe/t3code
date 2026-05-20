import { afterEach, expect, test, vi } from "vitest";
import { T3Client } from "../src/t3-client";
import type { EffectiveConfig } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("starts a T3 turn by creating a missing thread before dispatching the turn", async () => {
  const commands: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === "/api/orchestration/snapshot") {
        return jsonResponse({ projects: [], threads: [] });
      }
      if (url.pathname === "/api/orchestration/dispatch" && init?.body) {
        commands.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ sequence: commands.length });
      }
      return new Response("not found", { status: 404 });
    }),
  );

  const client = new T3Client(makeAgentPlaneConfig());
  const result = await client.startTurn({
    threadId: "symphony-run-test",
    projectId: "symphony-project-test",
    title: "Summarize the repo",
    prompt: "Summarize this repository.",
    workspacePath: "/tmp/t3-orchestrator-client",
    createdAt: "2026-05-11T20:08:23.000Z",
  });

  expect(result.threadId).toBe("symphony-run-test");
  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({
    type: "thread.create",
    threadId: "symphony-run-test",
    projectId: "symphony-project-test",
    title: "Summarize the repo",
    worktreePath: "/tmp/t3-orchestrator-client",
  });
  expect(commands[1]).toMatchObject({
    type: "thread.turn.start",
    threadId: "symphony-run-test",
    titleSeed: "Summarize the repo",
  });
  expect(commands[1]?.bootstrap).toBeUndefined();
});

test("does not create a thread when startTurn is told the thread already exists", async () => {
  const commands: Array<Record<string, unknown>> = [];
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === "/api/orchestration/dispatch" && init?.body) {
      commands.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse({ sequence: commands.length });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);

  const client = new T3Client(makeAgentPlaneConfig());
  await client.startTurn({
    threadId: "symphony-run-existing",
    projectId: "symphony-project-test",
    title: "Continue work",
    prompt: "Continue.",
    workspacePath: "/tmp/t3-orchestrator-client",
    createThread: false,
  });

  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    type: "thread.turn.start",
    threadId: "symphony-run-existing",
  });
  expect(commands[0]?.bootstrap).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("retries transient T3 connection failures", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(
      new TypeError("Unable to connect. Is the computer able to access the url?"),
    )
    .mockResolvedValueOnce(jsonResponse({ projects: [], threads: [] }));
  vi.stubGlobal("fetch", fetch);

  const client = new T3Client(makeAgentPlaneConfig());
  const snapshot = await client.snapshot();

  expect(snapshot.threads).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("lists active T3 projects sorted by title", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse({
        projects: [
          {
            id: "deleted",
            title: "Deleted",
            workspaceRoot: "/tmp/deleted",
            deletedAt: "2026-05-11T00:00:00.000Z",
          },
          { id: "b", title: "Beta", workspaceRoot: "/tmp/beta" },
          { id: "a", title: "Alpha", workspaceRoot: "/tmp/alpha" },
        ],
        threads: [],
      }),
    ),
  );

  const client = new T3Client(makeAgentPlaneConfig());
  await expect(client.listProjects()).resolves.toEqual([
    { id: "a", title: "Alpha", workspaceRoot: "/tmp/alpha" },
    { id: "b", title: "Beta", workspaceRoot: "/tmp/beta" },
  ]);
});

test("creates a T3 project through orchestration dispatch", async () => {
  const commands: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === "/api/orchestration/dispatch" && init?.body) {
        commands.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ sequence: commands.length });
      }
      return new Response("not found", { status: 404 });
    }),
  );

  const client = new T3Client(makeAgentPlaneConfig());
  const project = await client.createProject({
    projectId: "project-123",
    title: "Orchestrator",
    workspaceRoot: "/tmp/t3-project",
  });

  expect(project).toEqual({
    id: "project-123",
    title: "Orchestrator",
    workspaceRoot: "/tmp/t3-project",
  });
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    type: "project.create",
    projectId: "project-123",
    title: "Orchestrator",
    workspaceRoot: "/tmp/t3-project",
    createWorkspaceRootIfMissing: true,
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.5" },
  });
});

test("fails waitForTurn when T3 records a provider session error before a latest turn exists", async () => {
  const client = new T3Client(makeAgentPlaneConfig({ poll_interval_ms: 1 }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      jsonResponse({
        projects: [],
        threads: [
          {
            id: "symphony-run-provider-failed",
            projectId: "symphony-project-test",
            title: "Provider failure",
            worktreePath: "/tmp/t3-orchestrator-client",
            latestTurn: null,
            session: { status: "ready", lastError: "Provider failed to start" },
            messages: [],
          },
        ],
      }),
    ),
  );

  const result = await client.waitForTurn({
    threadId: "symphony-run-provider-failed",
    timeoutMs: 100,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toBe("Provider failed to start");
});

function makeAgentPlaneConfig(
  overrides: Partial<EffectiveConfig["agent_plane"]> = {},
): EffectiveConfig["agent_plane"] {
  return {
    kind: "t3",
    base_url: "http://localhost:13775",
    auth_token: "test-token",
    provider_instance: "codex",
    project_id: null,
    model: "gpt-5.5",
    runtime_mode: "full-access",
    interaction_mode: "default",
    poll_interval_ms: 100,
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
