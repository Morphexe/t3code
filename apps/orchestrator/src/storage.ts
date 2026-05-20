import { access, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const ORCHESTRATION_DIR = path.join(".t3code", "orchestration");
export const WORKFLOW_FILE = "WORKFLOW.md";
export const TICKET_CREATION_WORKFLOW_FILE = "TICKET_CREATION_WORKFLOW.MD";
export const KANBAN_DB_FILE = "kanban.sqlite";

export type OrchestrationStoragePaths = {
  projectRoot: string;
  orchestrationDir: string;
  workflowPath: string;
  ticketCreationWorkflowPath: string;
  kanbanDbPath: string;
};

export function resolveProjectRoot(projectRoot?: string): string {
  const configured =
    projectRoot?.trim() ||
    process.env.T3CODE_ORCHESTRATION_PROJECT_ROOT?.trim() ||
    process.env.T3CODE_PROJECT_ROOT?.trim() ||
    process.cwd();
  return path.resolve(configured);
}

export function resolveOrchestrationStoragePaths(projectRoot?: string): OrchestrationStoragePaths {
  const resolvedProjectRoot = resolveProjectRoot(projectRoot);
  const orchestrationDir = path.join(resolvedProjectRoot, ORCHESTRATION_DIR);
  return {
    projectRoot: resolvedProjectRoot,
    orchestrationDir,
    workflowPath: path.join(orchestrationDir, WORKFLOW_FILE),
    ticketCreationWorkflowPath: path.join(orchestrationDir, TICKET_CREATION_WORKFLOW_FILE),
    kanbanDbPath: path.join(orchestrationDir, KANBAN_DB_FILE),
  };
}

export function defaultWorkflowPath(projectRoot?: string): string {
  return resolveOrchestrationStoragePaths(projectRoot).workflowPath;
}

export function defaultTicketCreationWorkflowPath(projectRoot?: string): string {
  return resolveOrchestrationStoragePaths(projectRoot).ticketCreationWorkflowPath;
}

export async function ensureProjectOrchestrationFiles(
  options: {
    projectRoot?: string;
    templatesRoot?: string;
  } = {},
): Promise<OrchestrationStoragePaths> {
  const paths = resolveOrchestrationStoragePaths(options.projectRoot);
  const templatesRoot = options.templatesRoot ?? path.resolve(import.meta.dirname, "..");
  await mkdir(paths.orchestrationDir, { recursive: true });
  await copyIfMissing(path.join(templatesRoot, WORKFLOW_FILE), paths.workflowPath);
  await copyIfMissing(
    path.join(templatesRoot, TICKET_CREATION_WORKFLOW_FILE),
    paths.ticketCreationWorkflowPath,
  );
  return paths;
}

async function copyIfMissing(source: string, destination: string) {
  try {
    await access(destination);
  } catch {
    await copyFile(source, destination);
  }
}
