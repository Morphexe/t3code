import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { EffectiveConfig } from "./types";

const REQUEST_RETRY_ATTEMPTS = 20;
const REQUEST_RETRY_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 15000;

export type T3Snapshot = {
  projects: T3Project[];
  threads: T3Thread[];
  snapshotSequence?: number;
  updatedAt?: string;
};

export type T3ProjectsResponse = {
  projects: T3Project[];
  snapshotSequence?: number;
};

export type T3Project = {
  id: string;
  title: string;
  workspaceRoot: string;
  deletedAt?: string | null;
};

export type T3Thread = {
  id: string;
  projectId: string;
  title: string;
  worktreePath: string | null;
  latestTurn: {
    turnId: string;
    state: "running" | "interrupted" | "completed" | "error";
    completedAt: string | null;
    assistantMessageId: string | null;
  } | null;
  session?: { status: string; lastError: string | null } | null;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    text: string;
    streaming: boolean;
    turnId: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  updatedAt?: string;
};

export type T3ModelSelection = { instanceId: string; model: string };

export type T3ProjectCreate = {
  title: string;
  workspaceRoot: string;
  projectId?: string;
  createWorkspaceRootIfMissing?: boolean;
};

export type T3TurnStart = {
  threadId: string;
  messageId?: string;
  projectId?: string;
  title: string;
  prompt: string;
  workspacePath: string;
  createdAt?: string;
  createThread?: boolean;
};

export type T3WaitResult = {
  ok: boolean;
  timedOut: boolean;
  interrupted: boolean;
  finalMessage: string | null;
  error: string | null;
  thread: T3Thread | null;
};

export class T3Client {
  constructor(private readonly config: EffectiveConfig["agent_plane"]) {}

  get modelSelection(): T3ModelSelection {
    return { instanceId: this.config.provider_instance, model: this.config.model };
  }

  async listProjects(): Promise<T3Project[]> {
    return (await this.projects()).projects
      .filter((project) => !project.deletedAt)
      .toSorted((left, right) =>
        `${left.title}\0${left.workspaceRoot}`.localeCompare(
          `${right.title}\0${right.workspaceRoot}`,
        ),
      );
  }

  async getProject(projectId: string): Promise<T3Project | null> {
    return (
      (await this.projects()).projects.find(
        (project) => project.id === projectId && !project.deletedAt,
      ) ?? null
    );
  }

  async createProject(input: T3ProjectCreate): Promise<T3Project> {
    const project: T3Project = {
      id: input.projectId ?? randomUUID(),
      title: input.title.trim() || path.basename(input.workspaceRoot) || "T3 project",
      workspaceRoot: path.resolve(input.workspaceRoot),
    };
    await this.dispatch({
      type: "project.create",
      commandId: commandId("project-create"),
      projectId: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing ?? true,
      defaultModelSelection: this.modelSelection,
      createdAt: new Date().toISOString(),
    });
    return project;
  }

  async ensureProject(
    workspacePath: string,
    title = path.basename(workspacePath),
  ): Promise<T3Project> {
    const existing = (await this.projects()).projects.find(
      (project) => project.workspaceRoot === workspacePath && !project.deletedAt,
    );
    if (existing) return existing;
    return this.createProject({
      projectId: projectIdForWorkspace(workspacePath),
      title: title || "Symphony workspace",
      workspaceRoot: workspacePath,
      createWorkspaceRootIfMissing: false,
    });
  }

  async startTurn(input: T3TurnStart): Promise<{ threadId: string; messageId: string }> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const projectId = input.projectId ?? projectIdForWorkspace(input.workspacePath);
    const messageId = input.messageId ?? `symphony-message-${crypto.randomUUID()}`;
    const modelSelection = this.modelSelection;
    if (input.createThread !== false) {
      const existingThread = (await this.snapshot()).threads.find(
        (thread) => thread.id === input.threadId,
      );
      if (!existingThread) {
        await this.dispatch({
          type: "thread.create",
          commandId: commandId("thread-create"),
          threadId: input.threadId,
          projectId,
          title: input.title,
          modelSelection,
          runtimeMode: this.config.runtime_mode,
          interactionMode: this.config.interaction_mode,
          branch: null,
          worktreePath: input.workspacePath,
          createdAt,
        });
      }
    }
    await this.dispatch({
      type: "thread.turn.start",
      commandId: commandId("turn-start"),
      threadId: input.threadId,
      message: {
        messageId,
        role: "user",
        text: input.prompt,
        attachments: [],
      },
      modelSelection,
      titleSeed: input.title,
      runtimeMode: this.config.runtime_mode,
      interactionMode: this.config.interaction_mode,
      createdAt,
    });
    return { threadId: input.threadId, messageId };
  }

  async interruptThread(threadId: string) {
    await this.dispatch({
      type: "thread.turn.interrupt",
      commandId: commandId("turn-interrupt"),
      threadId,
      createdAt: new Date().toISOString(),
    });
  }

  async waitForTurn(input: {
    threadId: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    onThread?: (thread: T3Thread, snapshot: T3Snapshot) => void;
  }): Promise<T3WaitResult> {
    const startedAt = Date.now();
    let lastSignature = "";
    while (true) {
      if (input.abortSignal?.aborted) {
        await this.interruptThread(input.threadId).catch(() => undefined);
        return {
          ok: false,
          timedOut: false,
          interrupted: true,
          finalMessage: null,
          error: "T3 turn aborted",
          thread: null,
        };
      }
      if (Date.now() - startedAt > input.timeoutMs) {
        await this.interruptThread(input.threadId).catch(() => undefined);
        return {
          ok: false,
          timedOut: true,
          interrupted: false,
          finalMessage: null,
          error: "T3 turn timed out",
          thread: null,
        };
      }

      const snapshot = await this.snapshot();
      const thread = snapshot.threads.find((item) => item.id === input.threadId) ?? null;
      if (thread) {
        const signature = threadSignature(thread);
        if (signature !== lastSignature) {
          lastSignature = signature;
          input.onThread?.(thread, snapshot);
        }
        const state = thread.latestTurn?.state;
        if (state === "completed")
          return {
            ok: true,
            timedOut: false,
            interrupted: false,
            finalMessage: finalAssistantMessage(thread),
            error: null,
            thread,
          };
        if (state === "error" || state === "interrupted") {
          return {
            ok: false,
            timedOut: false,
            interrupted: state === "interrupted",
            finalMessage: finalAssistantMessage(thread),
            error: thread.session?.lastError ?? `T3 turn ${state}`,
            thread,
          };
        }
        if (!state && thread.session?.lastError) {
          return {
            ok: false,
            timedOut: false,
            interrupted: false,
            finalMessage: finalAssistantMessage(thread),
            error: thread.session.lastError,
            thread,
          };
        }
      }
      await sleep(this.config.poll_interval_ms);
    }
  }

  async snapshot(): Promise<T3Snapshot> {
    return this.request<T3Snapshot>("/api/orchestration/snapshot");
  }

  async projects(): Promise<T3ProjectsResponse> {
    return this.request<T3ProjectsResponse>("/api/orchestration/projects").catch((error) => {
      if (error instanceof Error && /\b(404|405)\b/.test(error.message)) {
        return this.snapshot();
      }
      throw error;
    });
  }

  async dispatch(command: Record<string, unknown>): Promise<{ sequence: number }> {
    return this.request<{ sequence: number }>("/api/orchestration/dispatch", {
      method: "POST",
      body: JSON.stringify(command),
    });
  }

  private async request<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(endpoint, this.config.base_url);
    let lastError: unknown;
    for (let attempt = 1; attempt <= REQUEST_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            "content-type": "application/json",
            ...(this.config.auth_token
              ? { authorization: `Bearer ${this.config.auth_token}` }
              : {}),
            ...init.headers,
          },
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `T3 ${init.method ?? "GET"} ${endpoint} failed ${response.status}: ${body || response.statusText}`,
          );
        }
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (attempt === REQUEST_RETRY_ATTEMPTS || !isTransientFetchError(error)) throw error;
        await sleep(REQUEST_RETRY_DELAY_MS);
      }
    }
    throw lastError;
  }
}

export function projectIdForWorkspace(workspacePath: string) {
  return `symphony-project-${createHash("sha256").update(path.resolve(workspacePath)).digest("hex").slice(0, 20)}`;
}

export function finalAssistantMessage(thread: T3Thread): string | null {
  return thread.messages.toReversed().find((message) => message.role === "assistant")?.text ?? null;
}

function commandId(tag: string) {
  return `symphony:${tag}:${crypto.randomUUID()}`;
}

function isTransientFetchError(error: unknown) {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return /Unable to connect|fetch failed|ECONNREFUSED|ECONNRESET|EPIPE/.test(error.message);
}

function threadSignature(thread: T3Thread) {
  const lastMessage = thread.messages.at(-1);
  return JSON.stringify({
    state: thread.latestTurn?.state,
    updatedAt: thread.updatedAt,
    lastMessage: lastMessage
      ? { id: lastMessage.id, text: lastMessage.text, streaming: lastMessage.streaming }
      : null,
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
