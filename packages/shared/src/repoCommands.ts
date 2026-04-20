const COMMAND_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARGUMENT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PROMPT_PLACEHOLDER_PATTERN = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
export const DEFAULT_REPO_COMMANDS_FILE_PATH = ".t3commands.json";

export interface RepoPromptCommandDefinition {
  readonly kind: "prompt";
  readonly name: string;
  readonly arguments: ReadonlyArray<string>;
  readonly prompt: string;
  readonly description?: string;
}

export interface RepoWorkflowCommandCreateWorktreeStep {
  readonly type: "createWorktree";
  readonly baseBranch: string;
  readonly branch: string;
  readonly runSetupScript?: boolean;
}

export interface RepoWorkflowCommandRunProjectScriptStep {
  readonly type: "runProjectScript";
  readonly scriptId: string;
}

export interface RepoWorkflowCommandStartTurnStep {
  readonly type: "startTurn";
  readonly prompt: string;
}

export type RepoWorkflowCommandStep =
  | RepoWorkflowCommandCreateWorktreeStep
  | RepoWorkflowCommandRunProjectScriptStep
  | RepoWorkflowCommandStartTurnStep;

export interface RepoWorkflowCommandDefinition {
  readonly kind: "workflow";
  readonly name: string;
  readonly arguments: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<RepoWorkflowCommandStep>;
  readonly description?: string;
}

export type RepoCommandDefinition = RepoPromptCommandDefinition | RepoWorkflowCommandDefinition;

export interface ResolvedRepoWorkflowCommandCreateWorktreeStep {
  readonly type: "createWorktree";
  readonly baseBranch: string;
  readonly branch: string;
  readonly runSetupScript: boolean;
}

export interface ResolvedRepoWorkflowCommandRunProjectScriptStep {
  readonly type: "runProjectScript";
  readonly scriptId: string;
}

export interface ResolvedRepoWorkflowCommandStartTurnStep {
  readonly type: "startTurn";
  readonly prompt: string;
}

export type ResolvedRepoWorkflowCommandStep =
  | ResolvedRepoWorkflowCommandCreateWorktreeStep
  | ResolvedRepoWorkflowCommandRunProjectScriptStep
  | ResolvedRepoWorkflowCommandStartTurnStep;

export interface RepoCommandsFile {
  readonly commands: ReadonlyArray<RepoCommandDefinition>;
}

export interface RepoCommandInvocation {
  readonly commandName: string;
  readonly argumentValues: ReadonlyArray<string>;
}

export interface CreateRepoCommandInvocation {
  readonly command: RepoPromptCommandDefinition;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} must not be empty.`);
  }
  return trimmed;
}

function collectTemplatePlaceholders(template: string): ReadonlySet<string> {
  const placeholderNames = new Set<string>();
  let placeholderMatch: RegExpExecArray | null;
  while ((placeholderMatch = PROMPT_PLACEHOLDER_PATTERN.exec(template)) !== null) {
    const placeholderName = placeholderMatch[1];
    if (placeholderName) {
      placeholderNames.add(placeholderName);
    }
  }
  PROMPT_PLACEHOLDER_PATTERN.lastIndex = 0;
  return placeholderNames;
}

function assertTemplateArgumentsDeclared(
  template: string,
  argumentsList: ReadonlyArray<string>,
  fieldName: string,
): void {
  for (const placeholderName of collectTemplatePlaceholders(template)) {
    if (!argumentsList.includes(placeholderName)) {
      throw new Error(
        `${fieldName} references '$${placeholderName}' but it is not declared in arguments.`,
      );
    }
  }
}

function parseCommandSharedFields(
  record: Record<string, unknown>,
  index: number,
): {
  readonly name: string;
  readonly argumentsList: ReadonlyArray<string>;
  readonly description: string | undefined;
} {
  const name = asTrimmedString(record.name, `commands[${index}].name`);
  if (!COMMAND_NAME_PATTERN.test(name)) {
    throw new Error(
      `commands[${index}].name must use lowercase letters, numbers, and dashes only.`,
    );
  }

  if (!Array.isArray(record.arguments)) {
    throw new Error(`commands[${index}].arguments must be an array.`);
  }
  const argumentsList = record.arguments.map((argument, argumentIndex) => {
    const nextArgument = asTrimmedString(
      argument,
      `commands[${index}].arguments[${argumentIndex}]`,
    );
    if (!ARGUMENT_NAME_PATTERN.test(nextArgument)) {
      throw new Error(
        `commands[${index}].arguments[${argumentIndex}] must use identifier-style names.`,
      );
    }
    return nextArgument;
  });

  const duplicateArgument = argumentsList.find(
    (argument, argumentIndex) => argumentsList.indexOf(argument) !== argumentIndex,
  );
  if (duplicateArgument) {
    throw new Error(`commands[${index}] contains duplicate argument '${duplicateArgument}'.`);
  }

  const description =
    record.description === undefined
      ? undefined
      : asTrimmedString(record.description, `commands[${index}].description`);
  if (description !== undefined) {
    assertTemplateArgumentsDeclared(description, argumentsList, `commands[${index}].description`);
  }

  return {
    name,
    argumentsList,
    description,
  };
}

function parseWorkflowStep(
  value: unknown,
  commandIndex: number,
  stepIndex: number,
  argumentsList: ReadonlyArray<string>,
): RepoWorkflowCommandStep {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`commands[${commandIndex}].steps[${stepIndex}] must be an object.`);
  }

  const type = asTrimmedString(record.type, `commands[${commandIndex}].steps[${stepIndex}].type`);
  switch (type) {
    case "createWorktree": {
      const baseBranch = asTrimmedString(
        record.baseBranch,
        `commands[${commandIndex}].steps[${stepIndex}].baseBranch`,
      );
      const branch = asTrimmedString(
        record.branch,
        `commands[${commandIndex}].steps[${stepIndex}].branch`,
      );
      assertTemplateArgumentsDeclared(
        baseBranch,
        argumentsList,
        `commands[${commandIndex}].steps[${stepIndex}].baseBranch`,
      );
      assertTemplateArgumentsDeclared(
        branch,
        argumentsList,
        `commands[${commandIndex}].steps[${stepIndex}].branch`,
      );
      if (record.runSetupScript !== undefined && typeof record.runSetupScript !== "boolean") {
        throw new Error(
          `commands[${commandIndex}].steps[${stepIndex}].runSetupScript must be a boolean.`,
        );
      }
      return {
        type: "createWorktree",
        baseBranch,
        branch,
        ...(typeof record.runSetupScript === "boolean"
          ? { runSetupScript: record.runSetupScript }
          : {}),
      };
    }
    case "runProjectScript":
      return {
        type: "runProjectScript",
        scriptId: asTrimmedString(
          record.scriptId,
          `commands[${commandIndex}].steps[${stepIndex}].scriptId`,
        ),
      };
    case "startTurn": {
      const prompt = asTrimmedString(
        record.prompt,
        `commands[${commandIndex}].steps[${stepIndex}].prompt`,
      );
      assertTemplateArgumentsDeclared(
        prompt,
        argumentsList,
        `commands[${commandIndex}].steps[${stepIndex}].prompt`,
      );
      return {
        type: "startTurn",
        prompt,
      };
    }
    default:
      throw new Error(
        `commands[${commandIndex}].steps[${stepIndex}].type must be one of: createWorktree, runProjectScript, startTurn.`,
      );
  }
}

function parseWorkflowCommandDefinition(
  record: Record<string, unknown>,
  index: number,
): RepoWorkflowCommandDefinition {
  const { name, argumentsList, description } = parseCommandSharedFields(record, index);
  if (!Array.isArray(record.steps)) {
    throw new Error(`commands[${index}].steps must be an array.`);
  }
  const steps = record.steps.map((step, stepIndex) =>
    parseWorkflowStep(step, index, stepIndex, argumentsList),
  );
  if (steps.length === 0) {
    throw new Error(`commands[${index}].steps must not be empty.`);
  }
  const startTurnSteps = steps.filter((step) => step.type === "startTurn");
  if (startTurnSteps.length !== 1) {
    throw new Error(`commands[${index}] must contain exactly one startTurn step.`);
  }
  if (steps[steps.length - 1]?.type !== "startTurn") {
    throw new Error(`commands[${index}] must end with a startTurn step.`);
  }
  return {
    kind: "workflow",
    name,
    arguments: argumentsList,
    steps,
    ...(description !== undefined ? { description } : {}),
  };
}

function parsePromptCommandDefinition(
  record: Record<string, unknown>,
  index: number,
): RepoPromptCommandDefinition {
  const { name, argumentsList, description } = parseCommandSharedFields(record, index);
  const prompt = asTrimmedString(record.prompt, `commands[${index}].prompt`);
  assertTemplateArgumentsDeclared(prompt, argumentsList, `commands[${index}].prompt`);
  return {
    kind: "prompt",
    name,
    arguments: argumentsList,
    prompt,
    ...(description !== undefined ? { description } : {}),
  };
}

function parseCommandDefinition(value: unknown, index: number): RepoCommandDefinition {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`commands[${index}] must be an object.`);
  }
  const kindValue =
    record.kind === undefined ? undefined : asTrimmedString(record.kind, `commands[${index}].kind`);
  if (kindValue === "workflow") {
    return parseWorkflowCommandDefinition(record, index);
  }
  if (kindValue === undefined || kindValue === "prompt") {
    return parsePromptCommandDefinition(record, index);
  }
  throw new Error(`commands[${index}].kind must be either 'prompt' or 'workflow'.`);
}

export function parseRepoCommandsFile(input: unknown): RepoCommandsFile {
  const record = asRecord(input);
  if (!record) {
    throw new Error("Repo commands config must be an object.");
  }
  if (!Array.isArray(record.commands)) {
    throw new Error("Repo commands config must include a commands array.");
  }

  const commands = record.commands.map((command, index) => parseCommandDefinition(command, index));
  const duplicateName = commands.find(
    (command, index) =>
      commands.findIndex((candidate) => candidate.name === command.name) !== index,
  );
  if (duplicateName) {
    throw new Error(`Repo commands config contains duplicate command '${duplicateName.name}'.`);
  }

  return { commands };
}

export function parseRepoCommandsJson(json: string): RepoCommandsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Repo commands JSON is invalid: ${error instanceof Error ? error.message : String(error)}.`,
      { cause: error },
    );
  }
  return parseRepoCommandsFile(parsed);
}

export function inferRepoCommandArgumentsFromPrompt(prompt: string): ReadonlyArray<string> {
  const argumentNames: string[] = [];
  const seen = new Set<string>();
  let placeholderMatch: RegExpExecArray | null;
  while ((placeholderMatch = PROMPT_PLACEHOLDER_PATTERN.exec(prompt)) !== null) {
    const placeholderName = placeholderMatch[1];
    if (!placeholderName || seen.has(placeholderName)) {
      continue;
    }
    seen.add(placeholderName);
    argumentNames.push(placeholderName);
  }
  PROMPT_PLACEHOLDER_PATTERN.lastIndex = 0;
  return argumentNames;
}

export function createRepoCommandDefinition(input: {
  readonly name: string;
  readonly prompt: string;
  readonly description?: string;
}): RepoPromptCommandDefinition {
  const command = {
    kind: "prompt" as const,
    name: input.name,
    arguments: inferRepoCommandArgumentsFromPrompt(input.prompt),
    prompt: input.prompt,
    ...(input.description !== undefined ? { description: input.description } : {}),
  } satisfies RepoPromptCommandDefinition;

  return parsePromptCommandDefinition(command, 0);
}

export function parseCreateRepoCommandInvocation(
  input: string,
): CreateRepoCommandInvocation | null {
  const trimmed = input.trim();
  const match = /^\/create-command(?:\s+([a-z0-9]+(?:-[a-z0-9]+)*))?(?:\s+([\s\S]+))?$/i.exec(
    trimmed,
  );
  if (!match) {
    return null;
  }

  const commandName = match[1]?.trim() ?? "";
  const prompt = match[2]?.trim() ?? "";
  if (!commandName) {
    throw new Error("/create-command requires a command name.");
  }
  if (!prompt) {
    throw new Error("/create-command requires a prompt after the command name.");
  }

  return {
    command: createRepoCommandDefinition({
      name: commandName,
      prompt,
    }),
  };
}

export function parseRepoCommandInvocation(input: string): RepoCommandInvocation | null {
  const trimmed = input.trim();
  const match = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+(.+))?$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const commandName = match[1];
  const rawArguments = match[2] ?? "";
  if (!commandName) {
    return null;
  }
  return {
    commandName,
    argumentValues: rawArguments.trim() ? rawArguments.trim().split(/\s+/) : [],
  };
}

export function isRepoPromptCommand(
  command: RepoCommandDefinition,
): command is RepoPromptCommandDefinition {
  return command.kind === "prompt";
}

export function isRepoWorkflowCommand(
  command: RepoCommandDefinition,
): command is RepoWorkflowCommandDefinition {
  return command.kind === "workflow";
}

function renderTemplate(
  template: string,
  argumentValueByName: ReadonlyMap<string, string>,
): string {
  return template.replace(PROMPT_PLACEHOLDER_PATTERN, (placeholder, argumentName: string) => {
    const argumentValue = argumentValueByName.get(argumentName);
    return argumentValue ?? placeholder;
  });
}

function buildArgumentValueByName(
  command: RepoCommandDefinition,
  argumentValues: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  if (argumentValues.length !== command.arguments.length) {
    throw new Error(
      `/${command.name} expects ${command.arguments.length} argument${command.arguments.length === 1 ? "" : "s"} but received ${argumentValues.length}.`,
    );
  }

  return new Map(
    command.arguments.map((argumentName, index) => [argumentName, argumentValues[index]!] as const),
  );
}

export function renderRepoCommandPrompt(
  command: RepoPromptCommandDefinition,
  argumentValues: ReadonlyArray<string>,
): string {
  const argumentValueByName = buildArgumentValueByName(command, argumentValues);
  return renderTemplate(command.prompt, argumentValueByName);
}

export function resolveRepoCommandPromptFromInvocation(input: {
  readonly commands: ReadonlyArray<RepoCommandDefinition>;
  readonly invocation: string;
}): { readonly command: RepoPromptCommandDefinition; readonly prompt: string } | null {
  const invocation = parseRepoCommandInvocation(input.invocation);
  if (!invocation) {
    return null;
  }

  const command = input.commands.find(
    (candidate): candidate is RepoPromptCommandDefinition =>
      candidate.name === invocation.commandName && isRepoPromptCommand(candidate),
  );
  if (!command) {
    return null;
  }

  return {
    command,
    prompt: renderRepoCommandPrompt(command, invocation.argumentValues),
  };
}

export function resolveRepoWorkflowCommandFromInvocation(input: {
  readonly commands: ReadonlyArray<RepoCommandDefinition>;
  readonly invocation: string;
}): {
  readonly command: RepoWorkflowCommandDefinition;
  readonly steps: ReadonlyArray<ResolvedRepoWorkflowCommandStep>;
  readonly startTurnPrompt: string;
} | null {
  const invocation = parseRepoCommandInvocation(input.invocation);
  if (!invocation) {
    return null;
  }

  const command = input.commands.find(
    (candidate): candidate is RepoWorkflowCommandDefinition =>
      candidate.name === invocation.commandName && isRepoWorkflowCommand(candidate),
  );
  if (!command) {
    return null;
  }

  const argumentValueByName = buildArgumentValueByName(command, invocation.argumentValues);
  const steps = command.steps.map((step): ResolvedRepoWorkflowCommandStep => {
    switch (step.type) {
      case "createWorktree":
        return {
          type: "createWorktree",
          baseBranch: renderTemplate(step.baseBranch, argumentValueByName),
          branch: renderTemplate(step.branch, argumentValueByName),
          runSetupScript: step.runSetupScript ?? false,
        };
      case "runProjectScript":
        return {
          type: "runProjectScript",
          scriptId: step.scriptId,
        };
      case "startTurn":
        return {
          type: "startTurn",
          prompt: renderTemplate(step.prompt, argumentValueByName),
        };
    }
  });
  const startTurnStep = steps.find(
    (step): step is ResolvedRepoWorkflowCommandStartTurnStep => step.type === "startTurn",
  );
  if (!startTurnStep) {
    throw new Error(`/${command.name} must contain a startTurn step.`);
  }

  return {
    command,
    steps,
    startTurnPrompt: startTurnStep.prompt,
  };
}

export function upsertRepoCommand(
  file: RepoCommandsFile,
  command: RepoPromptCommandDefinition,
): RepoCommandsFile {
  const existingIndex = file.commands.findIndex((candidate) => candidate.name === command.name);
  if (existingIndex < 0) {
    return {
      commands: [...file.commands, command],
    };
  }

  return {
    commands: file.commands.map((candidate, index) =>
      index === existingIndex ? command : candidate,
    ),
  };
}

function toSerializableCommand(command: RepoCommandDefinition): Record<string, unknown> {
  if (command.kind === "prompt") {
    return {
      name: command.name,
      arguments: [...command.arguments],
      prompt: command.prompt,
      ...(command.description !== undefined ? { description: command.description } : {}),
    };
  }

  return {
    kind: "workflow",
    name: command.name,
    arguments: [...command.arguments],
    ...(command.description !== undefined ? { description: command.description } : {}),
    steps: command.steps.map((step) => ({ ...step })),
  };
}

export function stringifyRepoCommandsFile(file: RepoCommandsFile): string {
  return `${JSON.stringify(
    { commands: file.commands.map((command) => toSerializableCommand(command)) },
    null,
    2,
  )}\n`;
}
