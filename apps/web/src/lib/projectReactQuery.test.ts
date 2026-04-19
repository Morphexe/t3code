import { EnvironmentId, type EnvironmentApi } from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as environmentApi from "../environmentApi";
import { projectReadFileQueryOptions, repoCommandsQueryOptions } from "./projectReactQuery";

const environmentId = EnvironmentId.make("environment-local");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("projectReadFileQueryOptions", () => {
  it("forwards project file reads to the environment API", async () => {
    const readFile = vi.fn().mockResolvedValue({
      relativePath: ".t3commands.json",
      contents: "{\"commands\":[]}\n",
    });
    vi.spyOn(environmentApi, "ensureEnvironmentApi").mockReturnValue({
      projects: { readFile },
    } as unknown as EnvironmentApi);

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(
      projectReadFileQueryOptions({
        environmentId,
        cwd: "/repo/project",
        relativePath: ".t3commands.json",
      }),
    );

    expect(readFile).toHaveBeenCalledWith({
      cwd: "/repo/project",
      relativePath: ".t3commands.json",
    });
  });
});

describe("repoCommandsQueryOptions", () => {
  it("returns parsed commands when the repo config exists", async () => {
    const readFile = vi.fn().mockResolvedValue({
      relativePath: ".t3commands.json",
      contents: JSON.stringify({
        commands: [
          {
            name: "commit-shit",
            arguments: ["arg1", "arg2"],
            prompt: "Please Commit $arg1 to $arg2 else.",
          },
        ],
      }),
    });
    vi.spyOn(environmentApi, "ensureEnvironmentApi").mockReturnValue({
      projects: { readFile },
    } as unknown as EnvironmentApi);

    const queryClient = new QueryClient();
    const result = await queryClient.fetchQuery(
      repoCommandsQueryOptions({
        environmentId,
        cwd: "/repo/project",
      }),
    );

    expect(result).toEqual({
      commands: [
        {
          name: "commit-shit",
          arguments: ["arg1", "arg2"],
          prompt: "Please Commit $arg1 to $arg2 else.",
        },
      ],
    });
  });

  it("treats a missing repo command file as an empty command list", async () => {
    const readFile = vi.fn().mockRejectedValue({
      _tag: "ProjectReadFileError",
      reason: "not-found",
      message: "No such file or directory",
    });
    vi.spyOn(environmentApi, "ensureEnvironmentApi").mockReturnValue({
      projects: { readFile },
    } as unknown as EnvironmentApi);

    const queryClient = new QueryClient();
    const result = await queryClient.fetchQuery(
      repoCommandsQueryOptions({
        environmentId,
        cwd: "/repo/project",
      }),
    );

    expect(result).toEqual({ commands: [] });
  });
});
