const COMMAND_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARGUMENT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PROMPT_PLACEHOLDER_PATTERN = /\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
export const DEFAULT_REPO_COMMANDS_FILE_PATH = ".t3commands.json";

export interface RepoCommandDefinition {
  readonly name: string;
  readonly arguments: ReadonlyArray<string>;
  readonly prompt: string;
}

export interface RepoCommandsFile {
  readonly commands: ReadonlyArray<RepoCommandDefinition>;
}

export interface RepoCommandInvocation {
  readonly commandName: string;
  readonly argumentValues: ReadonlyArray<string>;
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

function parseCommandDefinition(value: unknown, index: number): RepoCommandDefinition {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`commands[${index}] must be an object.`);
  }

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

  const prompt = asTrimmedString(record.prompt, `commands[${index}].prompt`);
  const promptPlaceholderNames = new Set<string>();
  let placeholderMatch: RegExpExecArray | null;
  while ((placeholderMatch = PROMPT_PLACEHOLDER_PATTERN.exec(prompt)) !== null) {
    const placeholderName = placeholderMatch[1];
    if (placeholderName) {
      promptPlaceholderNames.add(placeholderName);
    }
  }
  PROMPT_PLACEHOLDER_PATTERN.lastIndex = 0;

  for (const placeholderName of promptPlaceholderNames) {
    if (!argumentsList.includes(placeholderName)) {
      throw new Error(
        `commands[${index}].prompt references '$${placeholderName}' but it is not declared in arguments.`,
      );
    }
  }

  return {
    name,
    arguments: argumentsList,
    prompt,
  };
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

export function renderRepoCommandPrompt(
  command: RepoCommandDefinition,
  argumentValues: ReadonlyArray<string>,
): string {
  if (argumentValues.length !== command.arguments.length) {
    throw new Error(
      `/${command.name} expects ${command.arguments.length} argument${command.arguments.length === 1 ? "" : "s"} but received ${argumentValues.length}.`,
    );
  }

  const argumentValueByName = new Map(
    command.arguments.map((argumentName, index) => [argumentName, argumentValues[index]!] as const),
  );

  return command.prompt.replace(PROMPT_PLACEHOLDER_PATTERN, (placeholder, argumentName: string) => {
    const argumentValue = argumentValueByName.get(argumentName);
    return argumentValue ?? placeholder;
  });
}

export function resolveRepoCommandPromptFromInvocation(input: {
  readonly commands: ReadonlyArray<RepoCommandDefinition>;
  readonly invocation: string;
}): { readonly command: RepoCommandDefinition; readonly prompt: string } | null {
  const invocation = parseRepoCommandInvocation(input.invocation);
  if (!invocation) {
    return null;
  }

  const command = input.commands.find((candidate) => candidate.name === invocation.commandName);
  if (!command) {
    return null;
  }

  return {
    command,
    prompt: renderRepoCommandPrompt(command, invocation.argumentValues),
  };
}
