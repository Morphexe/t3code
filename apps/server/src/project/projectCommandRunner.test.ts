import { MessageId, type OrchestrationReadModel, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { runProjectWorkflowCommand } from "./projectCommandRunner.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectSetupScriptRunnerShape } from "./Services/ProjectSetupScriptRunner.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const MESSAGE_ID = MessageId.make("message-1");

function makeDependencies(overrides?: {
  readonly commandsFileContents?: string;
  readonly readModel?: OrchestrationReadModel;
  readonly createWorktree?: GitCoreShape["createWorktree"];
  readonly dispatch?: OrchestrationEngineShape["dispatch"];
  readonly runSetupScript?: ProjectSetupScriptRunnerShape["runForThread"];
}) {
  const timestamp = "2026-04-20T12:00:00.000Z";
  const commandsFileContents =
    overrides?.commandsFileContents ??
    `{
      "commands": [
        {
          "kind": "workflow",
          "name": "create-ticket",
          "arguments": ["ticket"],
          "steps": [
            {
              "type": "createWorktree",
              "baseBranch": "main",
              "branch": "$ticket",
              "runSetupScript": true
            },
            {
              "type": "runProjectScript",
              "scriptId": "bootstrap-ticket"
            },
            {
              "type": "startTurn",
              "prompt": "Work on $ticket."
            }
          ]
        }
      ]
    }`;
  const readModel =
    overrides?.readModel ??
    ({
      snapshotSequence: 0,
      projects: [
        {
          id: PROJECT_ID,
          title: "Project",
          workspaceRoot: "/repo",
          defaultModelSelection: null,
          scripts: [
            {
              id: "bootstrap-ticket",
              name: "Bootstrap Ticket",
              command: "pnpm bootstrap-ticket",
              icon: "play",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: timestamp,
          updatedAt: timestamp,
          deletedAt: null,
        },
      ],
      threads: [],
      updatedAt: timestamp,
    } satisfies OrchestrationReadModel);

  const dispatch = vi.fn((command) =>
    Effect.succeed({
      sequence:
        command.type === "thread.create"
          ? 1
          : command.type === "thread.meta.update"
            ? 2
            : command.type === "thread.turn.start"
              ? 3
              : 4,
    }),
  );
  const createWorktree = vi.fn(() =>
    Effect.succeed({
      worktree: {
        path: "/tmp/worktrees/ABC-123",
        branch: "ABC-123",
      },
    }),
  );
  const runSetupScript = vi.fn(() =>
    Effect.succeed({
      status: "started" as const,
      scriptId: "setup",
      scriptName: "Setup",
      terminalId: "setup-terminal",
      cwd: "/tmp/worktrees/ABC-123",
    }),
  );
  const terminalOpen = vi.fn(() =>
    Effect.succeed({
      threadId: THREAD_ID,
      terminalId: "command-terminal",
      cwd: "/tmp/worktrees/ABC-123",
      worktreePath: "/tmp/worktrees/ABC-123",
      status: "running" as const,
      pid: 1,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: new Date().toISOString(),
      cols: 80,
      rows: 24,
      hasRunningSubprocess: false,
      runtimeEnv: null,
    }),
  );
  const terminalWrite = vi.fn(() => Effect.void);
  const readFile = vi.fn(() =>
    Effect.succeed({
      relativePath: ".t3commands.json",
      contents: commandsFileContents,
    }),
  );

  const deps: Parameters<typeof runProjectWorkflowCommand>[0] = {
    git: {
      createWorktree: overrides?.createWorktree ?? createWorktree,
    },
    orchestrationEngine: {
      getReadModel: () => Effect.succeed(readModel),
      dispatch: overrides?.dispatch ?? dispatch,
    },
    projectSetupScriptRunner: {
      runForThread: overrides?.runSetupScript ?? runSetupScript,
    },
    terminalManager: {
      open: terminalOpen,
      write: terminalWrite,
    },
    workspaceFileSystem: {
      readFile,
    },
  };

  return {
    deps,
    spies: {
      dispatch,
      createWorktree,
      runSetupScript,
      terminalOpen,
      terminalWrite,
      readFile,
    },
  };
}

describe("runProjectWorkflowCommand", () => {
  it("executes the workflow command with worktree creation, project script, and turn start", async () => {
    const { deps, spies } = makeDependencies();

    const result = await Effect.runPromise(
      runProjectWorkflowCommand(deps)({
        cwd: "/repo",
        invocation: "/create-ticket ABC-123",
        threadId: THREAD_ID,
        messageId: MESSAGE_ID,
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-20T12:00:00.000Z",
        createThread: {
          projectId: PROJECT_ID,
          title: "ABC-123",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-04-20T12:00:00.000Z",
        },
      }),
    );

    expect(result).toEqual({
      sequence: 3,
      messageText: "Work on ABC-123.",
    });
    expect(spies.readFile).toHaveBeenCalledWith({
      cwd: "/repo",
      relativePath: ".t3commands.json",
    });
    expect(spies.createWorktree).toHaveBeenCalledWith({
      cwd: "/repo",
      branch: "main",
      newBranch: "ABC-123",
      path: null,
    });
    expect(spies.runSetupScript).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      projectCwd: "/repo",
      worktreePath: "/tmp/worktrees/ABC-123",
    });
    expect(spies.terminalOpen).toHaveBeenCalledTimes(1);
    expect(spies.terminalWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        data: "pnpm bootstrap-ticket\r",
      }),
    );
    expect(spies.dispatch.mock.calls.map((call) => call[0]?.type)).toEqual([
      "thread.create",
      "thread.meta.update",
      "thread.turn.start",
    ]);
  });

  it("deletes a newly created thread when a later workflow step fails", async () => {
    const { deps, spies } = makeDependencies({
      readModel: {
        snapshotSequence: 0,
        projects: [
          {
            id: PROJECT_ID,
            title: "Project",
            workspaceRoot: "/repo",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-04-20T12:00:00.000Z",
            updatedAt: "2026-04-20T12:00:00.000Z",
            deletedAt: null,
          },
        ],
        threads: [],
        updatedAt: "2026-04-20T12:00:00.000Z",
      },
    });

    await expect(
      Effect.runPromise(
        runProjectWorkflowCommand(deps)({
          cwd: "/repo",
          invocation: "/create-ticket ABC-123",
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-04-20T12:00:00.000Z",
          createThread: {
            projectId: PROJECT_ID,
            title: "ABC-123",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-04-20T12:00:00.000Z",
          },
        }),
      ),
    ).rejects.toThrow("Project script 'bootstrap-ticket' was not found for 'create-ticket'.");

    expect(spies.dispatch.mock.calls.map((call) => call[0]?.type)).toEqual([
      "thread.create",
      "thread.meta.update",
      "thread.delete",
    ]);
  });

  it("resolves project and worktree context from an existing thread", async () => {
    const { deps, spies } = makeDependencies({
      commandsFileContents: `{
        "commands": [
          {
            "kind": "workflow",
            "name": "continue-ticket",
            "arguments": ["ticket"],
            "steps": [
              {
                "type": "runProjectScript",
                "scriptId": "bootstrap-ticket"
              },
              {
                "type": "startTurn",
                "prompt": "Continue $ticket."
              }
            ]
          }
        ]
      }`,
      readModel: {
        snapshotSequence: 0,
        projects: [
          {
            id: PROJECT_ID,
            title: "Project",
            workspaceRoot: "/repo",
            defaultModelSelection: null,
            scripts: [
              {
                id: "bootstrap-ticket",
                name: "Bootstrap Ticket",
                command: "pnpm bootstrap-ticket",
                icon: "play",
                runOnWorktreeCreate: false,
              },
            ],
            createdAt: "2026-04-20T12:00:00.000Z",
            updatedAt: "2026-04-20T12:00:00.000Z",
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: THREAD_ID,
            projectId: PROJECT_ID,
            title: "ABC-123",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "ABC-123",
            worktreePath: "/tmp/worktrees/ABC-123",
            latestTurn: null,
            createdAt: "2026-04-20T12:00:00.000Z",
            updatedAt: "2026-04-20T12:00:00.000Z",
            archivedAt: null,
            deletedAt: null,
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
        ],
        updatedAt: "2026-04-20T12:00:00.000Z",
      },
    });

    const result = await Effect.runPromise(
      runProjectWorkflowCommand(deps)({
        cwd: "/tmp/worktrees/ABC-123",
        invocation: "/continue-ticket ABC-123",
        threadId: THREAD_ID,
        messageId: MESSAGE_ID,
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-04-20T12:00:00.000Z",
      }),
    );

    expect(result).toEqual({
      sequence: 3,
      messageText: "Continue ABC-123.",
    });
    expect(spies.terminalOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        cwd: "/tmp/worktrees/ABC-123",
        worktreePath: "/tmp/worktrees/ABC-123",
      }),
    );
    expect(spies.dispatch.mock.calls.map((call) => call[0]?.type)).toEqual(["thread.turn.start"]);
  });
});
