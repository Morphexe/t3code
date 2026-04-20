import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { runProjectWorkflowCommand } from "./projectCommandRunner.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectSetupScriptRunnerShape } from "./Services/ProjectSetupScriptRunner.ts";
import type { TerminalManagerShape } from "../terminal/Services/Manager.ts";
import type { WorkspaceFileSystemShape } from "../workspace/Services/WorkspaceFileSystem.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const MESSAGE_ID = MessageId.make("message-1");

function makeDependencies(overrides?: {
  readonly commandsFileContents?: string;
  readonly readModel?: ReturnType<OrchestrationEngineShape["getReadModel"]> extends Effect.Effect<
    infer T,
    never,
    never
  >
    ? T
    : never;
  readonly createWorktree?: GitCoreShape["createWorktree"];
  readonly dispatch?: OrchestrationEngineShape["dispatch"];
  readonly runSetupScript?: ProjectSetupScriptRunnerShape["runForThread"];
}) {
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
        },
      ],
      threads: [],
    } as const);

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

  return {
    deps: {
      git: {
        createWorktree: overrides?.createWorktree ?? createWorktree,
      } as GitCoreShape,
      orchestrationEngine: {
        getReadModel: () => Effect.succeed(readModel),
        dispatch: overrides?.dispatch ?? dispatch,
      } as OrchestrationEngineShape,
      projectSetupScriptRunner: {
        runForThread: overrides?.runSetupScript ?? runSetupScript,
      } as ProjectSetupScriptRunnerShape,
      terminalManager: {
        open: terminalOpen,
        write: terminalWrite,
      } as TerminalManagerShape,
      workspaceFileSystem: {
        readFile,
      } as WorkspaceFileSystemShape,
    },
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
        projects: [
          {
            id: PROJECT_ID,
            title: "Project",
            workspaceRoot: "/repo",
            defaultModelSelection: null,
            scripts: [],
          },
        ],
        threads: [],
      } as const,
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
    ).rejects.toThrow(
      "Project script 'bootstrap-ticket' was not found for 'create-ticket'.",
    );

    expect(spies.dispatch.mock.calls.map((call) => call[0]?.type)).toEqual([
      "thread.create",
      "thread.meta.update",
      "thread.delete",
    ]);
  });
});
