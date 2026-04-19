import type {
  EnvironmentId,
  ProjectReadFileError,
  ProjectReadFileResult,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import {
  DEFAULT_REPO_COMMANDS_FILE_PATH,
  parseRepoCommandsJson,
  type RepoCommandsFile,
} from "@t3tools/shared/repoCommands";
import { queryOptions } from "@tanstack/react-query";
import { ensureEnvironmentApi } from "~/environmentApi";

export const projectQueryKeys = {
  all: ["projects"] as const,
  searchEntries: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    query: string,
    limit: number,
  ) => ["projects", "search-entries", environmentId ?? null, cwd, query, limit] as const,
  readFile: (environmentId: EnvironmentId | null, cwd: string | null, relativePath: string) =>
    ["projects", "read-file", environmentId ?? null, cwd, relativePath] as const,
  repoCommands: (environmentId: EnvironmentId | null, cwd: string | null, relativePath: string) =>
    ["projects", "repo-commands", environmentId ?? null, cwd, relativePath] as const,
};

const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};
const EMPTY_REPO_COMMANDS_RESULT: RepoCommandsFile = {
  commands: [],
};

export function isProjectReadFileNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeError = error as Partial<ProjectReadFileError> & {
    message?: unknown;
    reason?: unknown;
  };
  if (maybeError.reason === "not-found") {
    return true;
  }
  return (
    typeof maybeError.message === "string" &&
    maybeError.message.toLowerCase().includes("no such file")
  );
}

export function projectSearchEntriesQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.environmentId, input.cwd, input.query, limit),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Workspace entry search is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}

export function projectReadFileQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  relativePath: string;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.readFile(input.environmentId, input.cwd, input.relativePath),
    queryFn: async (): Promise<ProjectReadFileResult> => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Workspace file read is unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.readFile({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      input.relativePath.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
  });
}

export function repoCommandsQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  enabled?: boolean;
  relativePath?: string;
  staleTime?: number;
}) {
  const relativePath = input.relativePath ?? DEFAULT_REPO_COMMANDS_FILE_PATH;
  return queryOptions({
    queryKey: projectQueryKeys.repoCommands(input.environmentId, input.cwd, relativePath),
    queryFn: async (): Promise<RepoCommandsFile> => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Repo commands are unavailable.");
      }
      const api = ensureEnvironmentApi(input.environmentId);
      try {
        const file = await api.projects.readFile({
          cwd: input.cwd,
          relativePath,
        });
        return parseRepoCommandsJson(file.contents);
      } catch (error) {
        if (isProjectReadFileNotFoundError(error)) {
          return EMPTY_REPO_COMMANDS_RESULT;
        }
        throw error;
      }
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_REPO_COMMANDS_RESULT,
  });
}
