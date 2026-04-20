import { describe, expect, it } from "vitest";

import {
  createRepoCommandDefinition,
  inferRepoCommandArgumentsFromPrompt,
  isRepoPromptCommand,
  isRepoWorkflowCommand,
  parseCreateRepoCommandInvocation,
  parseRepoCommandInvocation,
  parseRepoCommandsJson,
  renderRepoCommandPrompt,
  resolveRepoCommandPromptFromInvocation,
  resolveRepoWorkflowCommandFromInvocation,
  stringifyRepoCommandsFile,
  upsertRepoCommand,
} from "./repoCommands.ts";

describe("parseRepoCommandsJson", () => {
  it("parses a simple prompt repo command config", () => {
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
          kind: "prompt",
          name: "commit-shit",
          arguments: ["arg1", "arg2"],
          prompt: "Please Commit $arg1 to $arg2 else.",
        },
      ],
    });
  });

  it("parses a workflow repo command config", () => {
    const parsed = parseRepoCommandsJson(`{
      "commands": [
        {
          "kind": "workflow",
          "name": "create-ticket",
          "description": "Create a worktree for $ticket",
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
    }`);

    expect(parsed).toEqual({
      commands: [
        {
          kind: "workflow",
          name: "create-ticket",
          description: "Create a worktree for $ticket",
          arguments: ["ticket"],
          steps: [
            {
              type: "createWorktree",
              baseBranch: "main",
              branch: "$ticket",
              runSetupScript: true,
            },
            {
              type: "runProjectScript",
              scriptId: "bootstrap-ticket",
            },
            {
              type: "startTurn",
              prompt: "Work on $ticket.",
            },
          ],
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

  it("rejects workflow commands without a terminal start step", () => {
    expect(() =>
      parseRepoCommandsJson(`{
        "commands": [
          {
            "kind": "workflow",
            "name": "create-ticket",
            "arguments": ["ticket"],
            "steps": [
              {
                "type": "createWorktree",
                "baseBranch": "main",
                "branch": "$ticket"
              }
            ]
          }
        ]
      }`),
    ).toThrow("commands[0] must contain exactly one startTurn step.");
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
            "kind": "workflow",
            "name": "commit-shit",
            "arguments": [],
            "steps": [
              {
                "type": "startTurn",
                "prompt": "Do it."
              }
            ]
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
      kind: "prompt",
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
        kind: "prompt",
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
    kind: "prompt" as const,
    name: "commit-shit",
    arguments: ["arg1", "arg2"],
    prompt: "Please Commit $arg1 to $arg2 else. Repeat: $arg1.",
  };

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
          kind: "prompt",
          name: "commit-shit",
          arguments: ["arg1", "arg2"],
          prompt: "Please Commit $arg1 to $arg2 else.",
        },
      ],
      invocation: "/commit-shit repo1 repo2",
    });

    expect(result).toEqual({
      command: {
        kind: "prompt",
        name: "commit-shit",
        arguments: ["arg1", "arg2"],
        prompt: "Please Commit $arg1 to $arg2 else.",
      },
      prompt: "Please Commit repo1 to repo2 else.",
    });
  });

  it("ignores workflow commands", () => {
    expect(
      resolveRepoCommandPromptFromInvocation({
        commands: [
          {
            kind: "workflow",
            name: "create-ticket",
            arguments: ["ticket"],
            steps: [
              {
                type: "startTurn",
                prompt: "Work on $ticket.",
              },
            ],
          },
        ],
        invocation: "/create-ticket ABC-123",
      }),
    ).toBeNull();
  });
});

describe("resolveRepoWorkflowCommandFromInvocation", () => {
  it("resolves a workflow command into rendered steps", () => {
    const result = resolveRepoWorkflowCommandFromInvocation({
      commands: [
        {
          kind: "workflow",
          name: "create-ticket",
          arguments: ["ticket"],
          steps: [
            {
              type: "createWorktree",
              baseBranch: "main",
              branch: "$ticket",
              runSetupScript: true,
            },
            {
              type: "runProjectScript",
              scriptId: "bootstrap-ticket",
            },
            {
              type: "startTurn",
              prompt: "Work on $ticket.",
            },
          ],
        },
      ],
      invocation: "/create-ticket ABC-123",
    });

    expect(result).toEqual({
      command: {
        kind: "workflow",
        name: "create-ticket",
        arguments: ["ticket"],
        steps: [
          {
            type: "createWorktree",
            baseBranch: "main",
            branch: "$ticket",
            runSetupScript: true,
          },
          {
            type: "runProjectScript",
            scriptId: "bootstrap-ticket",
          },
          {
            type: "startTurn",
            prompt: "Work on $ticket.",
          },
        ],
      },
      steps: [
        {
          type: "createWorktree",
          baseBranch: "main",
          branch: "ABC-123",
          runSetupScript: true,
        },
        {
          type: "runProjectScript",
          scriptId: "bootstrap-ticket",
        },
        {
          type: "startTurn",
          prompt: "Work on ABC-123.",
        },
      ],
      startTurnPrompt: "Work on ABC-123.",
    });
  });
});

describe("command kind guards", () => {
  it("identifies prompt and workflow commands", () => {
    const promptCommand = createRepoCommandDefinition({
      name: "commit-shit",
      prompt: "Commit $arg1.",
    });
    const workflowCommand = parseRepoCommandsJson(`{
      "commands": [
        {
          "kind": "workflow",
          "name": "create-ticket",
          "arguments": ["ticket"],
          "steps": [
            {
              "type": "startTurn",
              "prompt": "Work on $ticket."
            }
          ]
        }
      ]
    }`).commands[0]!;

    expect(isRepoPromptCommand(promptCommand)).toBe(true);
    expect(isRepoWorkflowCommand(promptCommand)).toBe(false);
    expect(isRepoPromptCommand(workflowCommand)).toBe(false);
    expect(isRepoWorkflowCommand(workflowCommand)).toBe(true);
  });
});

describe("upsertRepoCommand", () => {
  it("replaces an existing prompt command with the same name", () => {
    expect(
      upsertRepoCommand(
        {
          commands: [
            {
              kind: "prompt",
              name: "commit-shit",
              arguments: ["arg1"],
              prompt: "Old $arg1",
            },
          ],
        },
        {
          kind: "prompt",
          name: "commit-shit",
          arguments: ["arg1", "arg2"],
          prompt: "New $arg1 $arg2",
        },
      ),
    ).toEqual({
      commands: [
        {
          kind: "prompt",
          name: "commit-shit",
          arguments: ["arg1", "arg2"],
          prompt: "New $arg1 $arg2",
        },
      ],
    });
  });
});

describe("stringifyRepoCommandsFile", () => {
  it("formats prompt commands without forcing the prompt kind", () => {
    expect(
      stringifyRepoCommandsFile({
        commands: [
          {
            kind: "prompt",
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

  it("formats workflow commands with explicit kinds and steps", () => {
    expect(
      stringifyRepoCommandsFile({
        commands: [
          {
            kind: "workflow",
            name: "create-ticket",
            arguments: ["ticket"],
            description: "Create a worktree for $ticket",
            steps: [
              {
                type: "createWorktree",
                baseBranch: "main",
                branch: "$ticket",
                runSetupScript: true,
              },
              {
                type: "startTurn",
                prompt: "Work on $ticket.",
              },
            ],
          },
        ],
      }),
    ).toBe(`{
  "commands": [
    {
      "kind": "workflow",
      "name": "create-ticket",
      "arguments": [
        "ticket"
      ],
      "description": "Create a worktree for $ticket",
      "steps": [
        {
          "type": "createWorktree",
          "baseBranch": "main",
          "branch": "$ticket",
          "runSetupScript": true
        },
        {
          "type": "startTurn",
          "prompt": "Work on $ticket."
        }
      ]
    }
  ]
}
`);
  });
});
