import { describe, expect, it } from "vitest";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";

describe("searchSlashCommandItems", () => {
  it("moves exact provider command matches ahead of broader description matches", () => {
    const items = [
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal build mode",
      },
      {
        id: "repo-command:commit-shit",
        type: "repo-command",
        command: {
          kind: "prompt",
          name: "commit-shit",
          arguments: ["arg1", "arg2"],
          prompt: "Please Commit $arg1 to $arg2 else.",
        },
        label: "/commit-shit",
        description: "Repo command",
      },
      {
        id: "provider-slash-command:claudeAgent:ui",
        type: "provider-slash-command",
        provider: "claudeAgent",
        command: { name: "ui" },
        label: "/ui",
        description: "Explore, build, and refine UI.",
      },
      {
        id: "provider-slash-command:claudeAgent:frontend-design",
        type: "provider-slash-command",
        provider: "claudeAgent",
        command: { name: "frontend-design" },
        label: "/frontend-design",
        description: "Create distinctive, production-grade frontend interfaces",
      },
    ] satisfies Array<
      Extract<
        ComposerCommandItem,
        { type: "slash-command" | "repo-command" | "provider-slash-command" }
      >
    >;

    expect(searchSlashCommandItems(items, "ui").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:ui",
      "slash:default",
    ]);
  });

  it("supports fuzzy provider command matches", () => {
    const items = [
      {
        id: "repo-command:github-fix",
        type: "repo-command",
        command: {
          kind: "prompt",
          name: "github-fix",
          arguments: ["arg1"],
          prompt: "Fix $arg1.",
        },
        label: "/github-fix",
        description: "Repo GitHub fixer",
      },
      {
        id: "provider-slash-command:claudeAgent:gh-fix-ci",
        type: "provider-slash-command",
        provider: "claudeAgent",
        command: { name: "gh-fix-ci" },
        label: "/gh-fix-ci",
        description: "Fix failing GitHub Actions",
      },
      {
        id: "provider-slash-command:claudeAgent:github",
        type: "provider-slash-command",
        provider: "claudeAgent",
        command: { name: "github" },
        label: "/github",
        description: "General GitHub help",
      },
    ] satisfies Array<
      Extract<
        ComposerCommandItem,
        { type: "slash-command" | "repo-command" | "provider-slash-command" }
      >
    >;

    expect(searchSlashCommandItems(items, "gfc").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:gh-fix-ci",
    ]);
  });
});
