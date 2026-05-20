import { existsSync } from "node:fs";
import path from "node:path";

export type WorkspaceDiffFile = {
  path: string;
  status: string;
};

export type WorkspaceDiff = {
  workspace_path: string | null;
  available: boolean;
  is_git_worktree: boolean;
  files: WorkspaceDiffFile[];
  all_files: string[];
  stat: string;
  patch: string;
  error: string | null;
};

const maxPatchChars = 240000;

export async function getWorkspaceDiff(workspacePath: string | null): Promise<WorkspaceDiff> {
  if (!workspacePath) return emptyDiff(null, "No workspace path recorded for this run.");
  const resolved = path.resolve(workspacePath);
  if (!existsSync(resolved)) return emptyDiff(resolved, "Workspace no longer exists.");
  if (!(await isGitWorktree(resolved)))
    return emptyDiff(resolved, "Workspace is not a Git worktree.");

  const status = await runGit(resolved, ["status", "--porcelain=v1", "-uall"]);
  const allFiles = await runGit(resolved, ["ls-files", "-co", "--exclude-standard"]);
  const stat = await runGit(resolved, ["diff", "--stat", "HEAD", "--"]);
  const patch = await runGit(resolved, ["diff", "--no-ext-diff", "--patch", "HEAD", "--"]);
  const files = parseStatus(status.stdout);
  return {
    workspace_path: resolved,
    available: true,
    is_git_worktree: true,
    files,
    all_files: parseFileList(allFiles.stdout, files),
    stat: stat.stdout.trim(),
    patch: truncatePatch(patch.stdout.trim()),
    error: null,
  };
}

function emptyDiff(workspacePath: string | null, error: string): WorkspaceDiff {
  return {
    workspace_path: workspacePath,
    available: false,
    is_git_worktree: false,
    files: [],
    all_files: [],
    stat: "",
    patch: "",
    error,
  };
}

async function isGitWorktree(cwd: string) {
  const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.stdout.trim() === "true";
}

async function runGit(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && args[0] !== "rev-parse") {
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed with exit ${code}`);
  }
  return { stdout, stderr, code };
}

function parseStatus(source: string): WorkspaceDiffFile[] {
  return source
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || "modified";
      const filePath = line.slice(3).replace(/^"|"$/g, "");
      return { path: filePath, status };
    });
}

function parseFileList(source: string, changedFiles: WorkspaceDiffFile[]): string[] {
  return uniqueSorted([
    ...source
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    ...changedFiles.map((file) => file.path),
  ]);
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function truncatePatch(source: string) {
  if (source.length <= maxPatchChars) return source;
  return `${source.slice(0, maxPatchChars)}\n\n[diff truncated at ${maxPatchChars} characters]`;
}
