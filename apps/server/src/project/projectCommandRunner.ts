import {
  CommandId,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProjectRunCommandInput,
  ProjectRunCommandError,
  type ProjectRunCommandResult,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  DEFAULT_REPO_COMMANDS_FILE_PATH,
  isRepoWorkflowCommand,
  parseRepoCommandInvocation,
  parseRepoCommandsJson,
  resolveRepoWorkflowCommandFromInvocation,
  type ResolvedRepoWorkflowCommandStep,
} from "@t3tools/shared/repoCommands";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { Cause, Effect, Schema } from "effect";

import type { GitWorkflowServiceShape } from "../git/GitWorkflowService.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectSetupScriptRunnerShape } from "./Services/ProjectSetupScriptRunner.ts";
import type { TerminalManagerShape } from "../terminal/Services/Manager.ts";
import type { WorkspaceFileSystemShape } from "../workspace/Services/WorkspaceFileSystem.ts";

interface ProjectWorkflowCommandRunnerDependencies {
  readonly git: Pick<GitWorkflowServiceShape, "createWorktree">;
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly projectionSnapshotQuery: Pick<ProjectionSnapshotQueryShape, "getSnapshot">;
  readonly projectSetupScriptRunner: Pick<ProjectSetupScriptRunnerShape, "runForThread">;
  readonly terminalManager: Pick<TerminalManagerShape, "open" | "write">;
  readonly workspaceFileSystem: Pick<WorkspaceFileSystemShape, "readFile">;
}

function makeServerCommandId(tag: string) {
  return CommandId.make(`server:${tag}:${crypto.randomUUID()}`);
}

function toProjectRunCommandError(cause: unknown, fallbackMessage: string): ProjectRunCommandError {
  if (Schema.is(ProjectRunCommandError)(cause)) {
    return cause;
  }

  const message =
    cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallbackMessage;
  return new ProjectRunCommandError({
    message,
    cause,
  });
}

function findProjectForWorkflowCommand(input: {
  readonly readModel: OrchestrationReadModel;
  readonly cwd: string;
  readonly projectId: string | undefined;
  readonly commandName: string;
}): OrchestrationProject {
  const project =
    (input.projectId
      ? input.readModel.projects.find((candidate) => candidate.id === input.projectId)
      : null) ??
    input.readModel.projects.find((candidate) => candidate.workspaceRoot === input.cwd) ??
    null;

  if (project) {
    return project;
  }

  throw new ProjectRunCommandError({
    message: `Project was not found for '/${input.commandName}'.`,
  });
}

function findThreadForWorkflowCommand(input: {
  readonly readModel: OrchestrationReadModel;
  readonly threadId: string;
}): OrchestrationThread | null {
  return input.readModel.threads.find((candidate) => candidate.id === input.threadId) ?? null;
}

function findScriptForWorkflowCommand(input: {
  readonly project: OrchestrationProject;
  readonly scriptId: string;
  readonly commandName: string;
}): ProjectScript {
  const script = input.project.scripts.find((candidate) => candidate.id === input.scriptId) ?? null;
  if (script) {
    return script;
  }

  throw new ProjectRunCommandError({
    message: `Project script '${input.scriptId}' was not found for '${input.commandName}'.`,
  });
}

export function runProjectWorkflowCommand(deps: ProjectWorkflowCommandRunnerDependencies) {
  return (
    input: ProjectRunCommandInput,
  ): Effect.Effect<ProjectRunCommandResult, ProjectRunCommandError> => {
    let createdThread = false;

    const program = Effect.gen(function* () {
      const parsedInvocation = parseRepoCommandInvocation(input.invocation);
      if (!parsedInvocation) {
        return yield* new ProjectRunCommandError({
          message: "Project command invocation must start with '/'.",
        });
      }

      const commandsFile = yield* deps.workspaceFileSystem
        .readFile({
          cwd: input.cwd,
          relativePath: DEFAULT_REPO_COMMANDS_FILE_PATH,
        })
        .pipe(
          Effect.mapError((cause) =>
            toProjectRunCommandError(
              cause,
              `Failed to read '${DEFAULT_REPO_COMMANDS_FILE_PATH}' from '${input.cwd}'.`,
            ),
          ),
        );

      const repoCommandsFile = yield* Effect.try({
        try: () => parseRepoCommandsJson(commandsFile.contents),
        catch: (cause) =>
          toProjectRunCommandError(cause, `Failed to parse '${DEFAULT_REPO_COMMANDS_FILE_PATH}'.`),
      });

      const matchingCommand =
        repoCommandsFile.commands.find(
          (candidate) => candidate.name === parsedInvocation.commandName,
        ) ?? null;
      if (!matchingCommand) {
        return yield* new ProjectRunCommandError({
          message: `Workflow command '/${parsedInvocation.commandName}' was not found.`,
        });
      }
      if (!isRepoWorkflowCommand(matchingCommand)) {
        return yield* new ProjectRunCommandError({
          message: `/${parsedInvocation.commandName} is a prompt command and cannot run a workflow.`,
        });
      }

      const resolvedWorkflowCommand = yield* Effect.try({
        try: () =>
          resolveRepoWorkflowCommandFromInvocation({
            commands: repoCommandsFile.commands,
            invocation: input.invocation,
          }),
        catch: (cause) =>
          toProjectRunCommandError(cause, `Failed to resolve '/${parsedInvocation.commandName}'.`),
      });
      if (!resolvedWorkflowCommand) {
        return yield* new ProjectRunCommandError({
          message: `Workflow command '/${parsedInvocation.commandName}' was not found.`,
        });
      }

      const readModel = yield* deps.projectionSnapshotQuery
        .getSnapshot()
        .pipe(
          Effect.mapError((cause) =>
            toProjectRunCommandError(cause, "Failed to load orchestration snapshot."),
          ),
        );
      const existingThread = findThreadForWorkflowCommand({
        readModel,
        threadId: input.threadId,
      });
      let resolvedProject: OrchestrationProject | null = null;
      const getProject = () =>
        Effect.try({
          try: () => {
            resolvedProject ??= findProjectForWorkflowCommand({
              readModel,
              cwd: input.cwd,
              projectId: input.createThread?.projectId ?? existingThread?.projectId,
              commandName: resolvedWorkflowCommand.command.name,
            });
            return resolvedProject;
          },
          catch: (cause) =>
            toProjectRunCommandError(
              cause,
              `Project was not found for '/${resolvedWorkflowCommand.command.name}'.`,
            ),
        });

      if (input.createThread) {
        yield* deps.orchestrationEngine
          .dispatch({
            type: "thread.create",
            commandId: makeServerCommandId("project-command-thread-create"),
            threadId: input.threadId,
            projectId: input.createThread.projectId,
            title: input.createThread.title,
            modelSelection: input.createThread.modelSelection,
            runtimeMode: input.createThread.runtimeMode,
            interactionMode: input.createThread.interactionMode,
            branch: input.createThread.branch,
            worktreePath: input.createThread.worktreePath,
            createdAt: input.createThread.createdAt,
          })
          .pipe(
            Effect.mapError((cause) =>
              toProjectRunCommandError(cause, "Failed to create workflow thread."),
            ),
          );
        createdThread = true;
      }

      let currentWorktreePath =
        input.createThread?.worktreePath ?? existingThread?.worktreePath ?? null;
      let latestSequence = 0;

      for (const step of resolvedWorkflowCommand.steps) {
        latestSequence = yield* runWorkflowStep({
          deps,
          input,
          step,
          commandName: resolvedWorkflowCommand.command.name,
          getProject,
          currentWorktreePath,
        }).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              currentWorktreePath = result.currentWorktreePath;
            }),
          ),
          Effect.map((result) => result.sequence),
        );
      }

      return {
        sequence: latestSequence,
        messageText: resolvedWorkflowCommand.startTurnPrompt,
      } satisfies ProjectRunCommandResult;
    });

    return program.pipe(
      Effect.catchCause((cause) => {
        const error = toProjectRunCommandError(
          Cause.squash(cause),
          "Failed to run project workflow command.",
        );
        if (!createdThread) {
          return Effect.fail(error);
        }

        return deps.orchestrationEngine
          .dispatch({
            type: "thread.delete",
            commandId: makeServerCommandId("project-command-thread-delete"),
            threadId: input.threadId,
          })
          .pipe(Effect.ignore({ log: true }), Effect.andThen(Effect.fail(error)));
      }),
    );
  };
}

function runWorkflowStep(input: {
  readonly deps: ProjectWorkflowCommandRunnerDependencies;
  readonly input: ProjectRunCommandInput;
  readonly step: ResolvedRepoWorkflowCommandStep;
  readonly commandName: string;
  readonly getProject: () => Effect.Effect<OrchestrationProject, ProjectRunCommandError>;
  readonly currentWorktreePath: string | null;
}): Effect.Effect<
  { readonly sequence: number; readonly currentWorktreePath: string | null },
  ProjectRunCommandError
> {
  const step = input.step;

  switch (step.type) {
    case "createWorktree":
      return Effect.gen(function* () {
        const result = yield* input.deps.git
          .createWorktree({
            cwd: input.input.cwd,
            refName: step.baseBranch,
            newRefName: step.branch,
            path: null,
          })
          .pipe(
            Effect.mapError((cause) =>
              toProjectRunCommandError(
                cause,
                `Failed to create worktree for '/${input.commandName}'.`,
              ),
            ),
          );

        const sequence = (yield* input.deps.orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: makeServerCommandId("project-command-thread-meta"),
            threadId: input.input.threadId,
            branch: result.worktree.refName,
            worktreePath: result.worktree.path,
          })
          .pipe(
            Effect.mapError((cause) =>
              toProjectRunCommandError(
                cause,
                `Failed to update thread metadata for '/${input.commandName}'.`,
              ),
            ),
          )).sequence;

        if (step.runSetupScript) {
          const project = yield* input.getProject();
          yield* input.deps.projectSetupScriptRunner
            .runForThread({
              threadId: input.input.threadId,
              projectId: project.id,
              projectCwd: project.workspaceRoot,
              worktreePath: result.worktree.path,
            })
            .pipe(
              Effect.mapError((cause) =>
                toProjectRunCommandError(
                  cause,
                  `Failed to run setup script for '/${input.commandName}'.`,
                ),
              ),
            );
        }

        return {
          sequence,
          currentWorktreePath: result.worktree.path,
        } as const;
      });

    case "runProjectScript":
      return Effect.gen(function* () {
        const project = yield* input.getProject();
        const script = findScriptForWorkflowCommand({
          project,
          scriptId: step.scriptId,
          commandName: input.commandName,
        });
        const cwd = projectScriptCwd({
          project: {
            cwd: project.workspaceRoot,
          },
          worktreePath: input.currentWorktreePath,
        });
        const env = projectScriptRuntimeEnv({
          project: {
            cwd: project.workspaceRoot,
          },
          worktreePath: input.currentWorktreePath,
        });
        const terminalId = `script-${script.id}`;

        yield* input.deps.terminalManager
          .open({
            threadId: input.input.threadId,
            terminalId,
            cwd,
            ...(input.currentWorktreePath !== null
              ? { worktreePath: input.currentWorktreePath }
              : {}),
            env,
          })
          .pipe(
            Effect.mapError((cause) =>
              toProjectRunCommandError(
                cause,
                `Failed to open a terminal for script '${script.id}'.`,
              ),
            ),
          );
        yield* input.deps.terminalManager
          .write({
            threadId: input.input.threadId,
            terminalId,
            data: `${script.command}\r`,
          })
          .pipe(
            Effect.mapError((cause) =>
              toProjectRunCommandError(
                cause,
                `Failed to start script '${script.id}' in the terminal.`,
              ),
            ),
          );

        return {
          sequence: 0,
          currentWorktreePath: input.currentWorktreePath,
        } as const;
      });

    case "startTurn":
      return input.deps.orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId: makeServerCommandId("project-command-turn-start"),
          threadId: input.input.threadId,
          message: {
            messageId: input.input.messageId,
            role: "user",
            text: step.prompt,
            attachments: [],
          },
          modelSelection: input.input.modelSelection,
          runtimeMode: input.input.runtimeMode,
          interactionMode: input.input.interactionMode,
          createdAt: input.input.createdAt,
        })
        .pipe(
          Effect.mapError((cause) =>
            toProjectRunCommandError(cause, `Failed to start '/${input.commandName}'.`),
          ),
          Effect.map((result) => ({
            sequence: result.sequence,
            currentWorktreePath: input.currentWorktreePath,
          })),
        );
  }
}
