import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { WorkflowDefinition } from "./types";
import { defaultWorkflowPath, ensureProjectOrchestrationFiles } from "./storage";

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "missing_workflow_file"
      | "workflow_parse_error"
      | "workflow_front_matter_not_a_map",
  ) {
    super(message);
  }
}

export async function loadWorkflow(workflowPath?: string): Promise<WorkflowDefinition> {
  if (!workflowPath) {
    await ensureProjectOrchestrationFiles();
  }
  const selected = workflowPath ?? defaultWorkflowPath();
  const resolved = path.resolve(selected);
  let source: string;

  try {
    source = await readFile(resolved, "utf8");
  } catch (error) {
    throw new WorkflowError(
      `Cannot read workflow file at ${resolved}: ${String(error)}`,
      "missing_workflow_file",
    );
  }

  return parseWorkflowSource(source, resolved);
}

export function parseWorkflowSource(source: string, workflowPath: string): WorkflowDefinition {
  const resolved = path.resolve(workflowPath);
  const { frontMatter, body } = splitFrontMatter(source);
  let config: unknown = {};
  if (frontMatter !== null) {
    try {
      config = YAML.parse(frontMatter) ?? {};
    } catch (error) {
      throw new WorkflowError(
        `Cannot parse workflow front matter: ${String(error)}`,
        "workflow_parse_error",
      );
    }
  }

  if (!isPlainObject(config)) {
    throw new WorkflowError(
      "Workflow front matter must be a map/object",
      "workflow_front_matter_not_a_map",
    );
  }

  return {
    path: resolved,
    config,
    prompt_template: body.trim(),
    loaded_at: Date.now(),
  };
}

export function updateWorkflowSourceConfig(
  source: string,
  update: (config: Record<string, unknown>) => void,
): string {
  const { frontMatter, body } = splitFrontMatter(source);
  let config: unknown = {};
  if (frontMatter !== null) {
    try {
      config = YAML.parse(frontMatter) ?? {};
    } catch (error) {
      throw new WorkflowError(
        `Cannot parse workflow front matter: ${String(error)}`,
        "workflow_parse_error",
      );
    }
  }
  if (!isPlainObject(config)) {
    throw new WorkflowError(
      "Workflow front matter must be a map/object",
      "workflow_front_matter_not_a_map",
    );
  }
  update(config);
  const nextFrontMatter = YAML.stringify(config).trimEnd();
  return `---\n${nextFrontMatter}\n---\n${body}`;
}

function splitFrontMatter(source: string): { frontMatter: string | null; body: string } {
  if (!source.startsWith("---")) return { frontMatter: null, body: source };
  const normalized = source.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { frontMatter: null, body: source };
  const afterEnd = normalized.indexOf("\n", end + 4);
  return {
    frontMatter: normalized.slice(3, end).trim(),
    body: afterEnd === -1 ? "" : normalized.slice(afterEnd + 1),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
