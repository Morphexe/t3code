import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { sanitizeWorkspaceKey } from "./state";
import type { EffectiveConfig, Issue, Workspace } from "./types";

export class WorkspaceManager {
  async ensureWorkspace(issue: Issue, config: EffectiveConfig): Promise<Workspace> {
    const workspace_key = sanitizeWorkspaceKey(issue.identifier);
    const workspacePath = path.join(config.workspace.root, workspace_key);
    const created_now = !existsSync(workspacePath);
    await mkdir(workspacePath, { recursive: true });
    if (config.workspace.seed_from && (created_now || (await isDirectoryEmpty(workspacePath)))) {
      await seedWorkspace(
        issue,
        config.workspace.seed_from,
        workspacePath,
        config.workspace.root,
        config.workspace.mode,
      );
    }
    if (created_now && config.hooks.after_create) {
      await runHook(config.hooks.after_create, workspacePath, config.hooks.timeout_ms);
    }
    return { path: workspacePath, workspace_key, created_now };
  }

  async removeWorkspace(issue: Issue, config: EffectiveConfig): Promise<void> {
    const workspacePath = path.join(config.workspace.root, sanitizeWorkspaceKey(issue.identifier));
    if (!existsSync(workspacePath)) return;
    if (config.hooks.before_remove) {
      try {
        await runHook(config.hooks.before_remove, workspacePath, config.hooks.timeout_ms);
      } catch {
        // Cleanup continues by spec even if before_remove fails.
      }
    }
    if (config.workspace.seed_from && (await isGitWorktree(workspacePath))) {
      try {
        await runCommand(
          ["git", "-C", config.workspace.seed_from, "worktree", "remove", "--force", workspacePath],
          config.workspace.seed_from,
          config.hooks.timeout_ms,
        );
        return;
      } catch {
        // Fall back to filesystem removal when Git metadata is already stale.
      }
    }
    await rm(workspacePath, { recursive: true, force: true });
  }
}

async function isDirectoryEmpty(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length === 0;
  } catch {
    return true;
  }
}

async function seedWorkspace(
  issue: Issue,
  source: string,
  destination: string,
  workspaceRoot: string,
  mode: EffectiveConfig["workspace"]["mode"],
) {
  if (mode !== "copy" && (await isGitRepository(source))) {
    await createGitWorktree(issue, source, destination);
    return;
  }
  if (mode === "git_worktree") {
    throw new Error(`workspace.mode is git_worktree, but ${source} is not a Git repository`);
  }
  await copyTree(
    path.resolve(source),
    path.resolve(destination),
    path.resolve(source),
    path.resolve(workspaceRoot),
  );
}

async function createGitWorktree(issue: Issue, source: string, destination: string) {
  const branch = `symphony/${sanitizeWorkspaceKey(issue.identifier)}`;
  await rm(destination, { recursive: true, force: true });
  await runCommand(
    ["git", "-C", source, "worktree", "add", "--force", "-B", branch, destination, "HEAD"],
    source,
    120000,
  );
}

async function copyTree(
  sourcePath: string,
  destinationPath: string,
  sourceRoot: string,
  workspaceRoot: string,
) {
  if (!shouldCopy(sourcePath, sourceRoot, workspaceRoot)) return;
  const stat = await lstat(sourcePath);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await mkdir(destinationPath, { recursive: true });
    const entries = await readdir(sourcePath);
    for (const entry of entries) {
      await copyTree(
        path.join(sourcePath, entry),
        path.join(destinationPath, entry),
        sourceRoot,
        workspaceRoot,
      );
    }
    return;
  }
  if (stat.isFile()) {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    if (!existsSync(destinationPath)) await copyFile(sourcePath, destinationPath);
  }
}

function shouldCopy(sourcePath: string, sourceRoot: string, workspaceRoot: string) {
  const resolved = path.resolve(sourcePath);
  if (resolved === workspaceRoot || resolved.startsWith(`${workspaceRoot}${path.sep}`))
    return false;
  const relative = path.relative(sourceRoot, resolved);
  if (!relative) return true;
  const top = relative.split(path.sep)[0];
  if (!top) return true;
  if (["node_modules", ".git", ".data", "dist", "workspaces", "logs"].includes(top)) return false;
  return !resolved.startsWith(path.resolve(workspaceRoot));
}

export async function runHook(script: string, cwd: string, timeoutMs: number): Promise<void> {
  const proc = Bun.spawn(["sh", "-lc", script], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`Hook timed out after ${timeoutMs}ms`));
    }, timeoutMs).unref();
  });
  const exit = proc.exited.then(async (code) => {
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Hook failed with exit ${code}: ${stderr.trim()}`);
    }
  });
  await Promise.race([exit, timeout]);
}

async function isGitRepository(cwd: string) {
  try {
    await runCommand(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], cwd, 10000);
    return true;
  } catch {
    return false;
  }
}

async function isGitWorktree(cwd: string) {
  try {
    const stat = await lstat(path.join(cwd, ".git"));
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

async function runCommand(command: string[], cwd: string, timeoutMs: number) {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`${command.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs).unref();
  });
  const exit = proc.exited.then(async (code) => {
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`${command.join(" ")} failed with exit ${code}: ${stderr.trim()}`);
    }
  });
  await Promise.race([exit, timeout]);
}
