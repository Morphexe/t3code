import { describe, expect, it } from "vitest";
import { EnvironmentId, ProjectId, ProviderDriverKind, ThreadId, TurnId } from "@t3tools/contracts";

import { deriveAgentNotificationTransition } from "./agentNotificationSounds";
import type { SidebarThreadSummary } from "./types";

function makeThread(
  input: Partial<SidebarThreadSummary> & Pick<SidebarThreadSummary, "id">,
): SidebarThreadSummary {
  return {
    id: input.id,
    environmentId: input.environmentId ?? EnvironmentId.make("environment-local"),
    projectId: input.projectId ?? ProjectId.make("project-1"),
    title: input.title ?? "Thread",
    interactionMode: input.interactionMode ?? "default",
    session:
      input.session ??
      ({
        provider: ProviderDriverKind.make("codex"),
        status: "ready",
        orchestrationStatus: "ready",
        createdAt: "2026-04-19T10:00:00.000Z",
        updatedAt: "2026-04-19T10:00:00.000Z",
      } as const),
    createdAt: input.createdAt ?? "2026-04-19T10:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    updatedAt: input.updatedAt ?? "2026-04-19T10:00:00.000Z",
    latestTurn: input.latestTurn ?? null,
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    hasActionableProposedPlan: input.hasActionableProposedPlan ?? false,
  };
}

describe("deriveAgentNotificationTransition", () => {
  it("does not emit sounds on the initial snapshot", () => {
    const transition = deriveAgentNotificationTransition(null, [
      makeThread({
        id: ThreadId.make("thread-1"),
        hasPendingUserInput: true,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          requestedAt: "2026-04-19T10:00:00.000Z",
          startedAt: "2026-04-19T10:00:01.000Z",
          completedAt: "2026-04-19T10:00:03.000Z",
          assistantMessageId: null,
        },
      }),
    ]);

    expect(transition.shouldPlayRequiresInputSound).toBe(false);
    expect(transition.shouldPlayFinishedSound).toBe(false);
  });

  it("emits a requires-input sound when a thread starts waiting for input", () => {
    const previous = deriveAgentNotificationTransition(null, [
      makeThread({ id: ThreadId.make("thread-1") }),
    ]).next;

    const transition = deriveAgentNotificationTransition(previous, [
      makeThread({
        id: ThreadId.make("thread-1"),
        hasPendingApprovals: true,
      }),
    ]);

    expect(transition.shouldPlayRequiresInputSound).toBe(true);
    expect(transition.shouldPlayFinishedSound).toBe(false);
  });

  it("emits a finished sound when a running turn settles", () => {
    const threadId = ThreadId.make("thread-1");
    const previous = deriveAgentNotificationTransition(null, [
      makeThread({
        id: threadId,
        session: {
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-1"),
          createdAt: "2026-04-19T10:00:00.000Z",
          updatedAt: "2026-04-19T10:00:01.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: "2026-04-19T10:00:00.000Z",
          startedAt: "2026-04-19T10:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    ]).next;

    const transition = deriveAgentNotificationTransition(previous, [
      makeThread({
        id: threadId,
        session: {
          provider: ProviderDriverKind.make("codex"),
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-19T10:00:00.000Z",
          updatedAt: "2026-04-19T10:00:03.000Z",
        },
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          requestedAt: "2026-04-19T10:00:00.000Z",
          startedAt: "2026-04-19T10:00:01.000Z",
          completedAt: "2026-04-19T10:00:03.000Z",
          assistantMessageId: null,
        },
      }),
    ]);

    expect(transition.shouldPlayRequiresInputSound).toBe(false);
    expect(transition.shouldPlayFinishedSound).toBe(true);
  });

  it("ignores completions for threads first seen after bootstrap", () => {
    const previous = deriveAgentNotificationTransition(null, [
      makeThread({ id: ThreadId.make("thread-1") }),
    ]).next;

    const transition = deriveAgentNotificationTransition(previous, [
      makeThread({ id: ThreadId.make("thread-1") }),
      makeThread({
        id: ThreadId.make("thread-2"),
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "completed",
          requestedAt: "2026-04-19T10:00:00.000Z",
          startedAt: "2026-04-19T10:00:01.000Z",
          completedAt: "2026-04-19T10:00:03.000Z",
          assistantMessageId: null,
        },
      }),
    ]);

    expect(transition.shouldPlayFinishedSound).toBe(false);
  });
});
