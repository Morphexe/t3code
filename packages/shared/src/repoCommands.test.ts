import { describe, expect, it } from "vitest";

import {
  createRepoCommandDefinition,
  inferRepoCommandArgumentsFromPrompt,
  parseCreateRepoCommandInvocation,
  parseRepoCommandInvocation,
  parseRepoCommandsJson,
  renderRepoCommandPrompt,
  resolveRepoCommandPromptFromInvocation,
  stringifyRepoCommandsFile,
  upsertRepoCommand,
} from "./repoCommands.ts";

describe("parseRepoCommandsJson", () => {
  it("parses a simple repo command config", () => {
    const parsed = parseRepoCommandsJson(`{
      "commands": [
        {
          "name": "commit-shit",
          "arguments": ["arg1", "arg2"],
          "prompt": "Please Commit $arg1 to $arg2 else."
        }
      ]
    }`);

    expect(parsed).toEqual({
      commands: [
        {
          name: "commit-shit",
          arguments: ["arg1", "arg2"],
          prompt: "Please Commit $arg1 to $arg2 else.",
        },
      ],
    });
  });

  it("rejects prompt placeholders that are not declared as arguments", () => {
    expect(() =>
      parseRepoCommandsJson(`{
        "commands": [
          {
            "name": "commit-shit",
            "arguments": ["arg1"],
            "prompt": "Please Commit $arg1 to $arg2 else."
          }
        ]
      }`),
    ).toThrow("commands[0].prompt references '$arg2' but it is not declared in arguments.");
  });

  it("rejects duplicate command names", () => {
    expect(() =>
      parseRepoCommandsJson(`{
        "commands": [
          {
            "name": "commit-shit",
            "arguments": ["arg1"],
            "prompt": "Please Commit $arg1."
          },
          {
            "name": "commit-shit",
            "arguments": ["arg1"],
            "prompt": "Please Commit $arg1 again."
          }
        ]
      }`),
    ).toThrow("Repo commands config contains duplicate command 'commit-shit'.");
  });
});

describe("parseRepoCommandInvocation", () => {
  it("parses a slash command invocation with positional arguments", () => {
    expect(parseRepoCommandInvocation("/commit-shit repo1 repo2")).toEqual({
      commandName: "commit-shit",
      argumentValues: ["repo1", "repo2"],
    });
  });

  it("returns null when the input is not a slash command", () => {
    expect(parseRepoCommandInvocation("commit-shit repo1 repo2")).toBeNull();
  });
});

describe("inferRepoCommandArgumentsFromPrompt", () => {
  it("collects unique placeholders in first-seen order", () => {
    expect(
      inferRepoCommandArgumentsFromPrompt(
        "Please Commit $arg1 to $arg2 else. Repeat $arg1 and $arg3.",
      ),
    ).toEqual(["arg1", "arg2", "arg3"]);
  });
});

describe("createRepoCommandDefinition", () => {
  it("infers arguments from prompt placeholders", () => {
    expect(
      createRepoCommandDefinition({
        name: "commit-shit",
        prompt: "Please Commit $arg1 to $arg2 else.",
      }),
    ).toEqual({
      name: "commit-shit",
      arguments: ["arg1", "arg2"],
      prompt: "Please Commit $arg1 to $arg2 else.",
    });
  });
});

describe("parseCreateRepoCommandInvocation", () => {
  it("parses a create-command invocation into a repo command definition", () => {
    expect(
      parseCreateRepoCommandInvocation(
        "/create-command commit-shit Please Commit $arg1 to $arg2 else.",
      ),
    ).toEqual({
      command: {
        name: "commit-shit",
        arguments: ["arg1", "arg2"],
        prompt: "Please Commit $arg1 to $arg2 else.",
      },
    });
  });

  it("throws when the command prompt is missing", () => {
    expect(() => parseCreateRepoCommandInvocation("/create-command commit-shit")).toThrow(
      "/create-command requires a prompt after the command name.",
    );
  });
});

describe("renderRepoCommandPrompt", () => {
  const command = {
    name: "commit-shit",
    arguments: ["arg1", "arg2"],
    prompt: "Please Commit $arg1 to $arg2 else. Repeat: $arg1.",
  } as const;

  it("injects positional arguments into matching prompt placeholders", () => {
    expect(renderRepoCommandPrompt(command, ["repo1", "repo2"])).toBe(
      "Please Commit repo1 to repo2 else. Repeat: repo1.",
    );
  });

  it("throws when required arguments are missing", () => {
    expect(() => renderRepoCommandPrompt(command, ["repo1"])).toThrow(
      "/commit-shit expects 2 arguments but received 1.",
    );
  });
});

describe("resolveRepoCommandPromptFromInvocation", () => {
  it("resolves a parsed slash command into its final prompt", () => {
    const result = resolveRepoCommandPromptFromInvocation({
      commands: [
        {
          name: "commit-shit",
          arguments: ["arg1", "arg2"],
          prompt: "Please Commit $arg1 to $arg2 else.",
        },
      ],
      invocation: "/commit-shit repo1 repo2",
    });

    expect(result).toEqual({
      command: {
        name: "commit-shit",
        arguments: ["arg1", "arg2"],
        prompt: "Please Commit $arg1 to $arg2 else.",
      },
      prompt: "Please Commit repo1 to repo2 else.",
    });
  });
});

describe("upsertRepoCommand", () => {
  it("replaces an existing command with the same name", () => {
    expect(
      upsertRepoCommand(
        {
          commands: [
            {
              name: "commit-shit",
              arguments: ["arg1"],
              prompt: "Old $arg1",
            },
          ],
        },
        {
          name: "commit-shit",
          arguments: ["arg1", "arg2"],
          prompt: "New $arg1 $arg2",
        },
      ),
    ).toEqual({
      commands: [
        {
          name: "commit-shit",
          arguments: ["arg1", "arg2"],
          prompt: "New $arg1 $arg2",
        },
      ],
    });
  });
});

describe("stringifyRepoCommandsFile", () => {
  it("formats the commands file as stable JSON", () => {
    expect(
      stringifyRepoCommandsFile({
        commands: [
          {
            name: "commit-shit",
            arguments: ["arg1", "arg2"],
            prompt: "Please Commit $arg1 to $arg2 else.",
          },
        ],
      }),
    ).toBe(`{
  "commands": [
    {
      "name": "commit-shit",
      "arguments": [
        "arg1",
        "arg2"
      ],
      "prompt": "Please Commit $arg1 to $arg2 else."
    }
  ]
}
`);
  });
});
