import fs from "node:fs/promises";
import path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { KanbanStore } from "./kanban";
import type { Orchestrator } from "./orchestrator";

type WsData = { id: string };

type RealtimeMessage = {
  type: string;
  [key: string]: unknown;
};

export class RealtimeHub {
  private sockets = new Set<ServerWebSocket<WsData>>();
  private server: Server<WsData> | null = null;
  private store: KanbanStore | null = null;
  private orchestrator: Orchestrator | null = null;

  attach(server: Server<WsData>, store: KanbanStore, orchestrator: Orchestrator) {
    this.server = server;
    this.store = store;
    this.orchestrator = orchestrator;
  }

  upgrade(request: Request) {
    if (!this.server) return false;
    return this.server.upgrade(request, { data: { id: crypto.randomUUID() } });
  }

  websocket = {
    open: (ws: ServerWebSocket<WsData>) => {
      this.sockets.add(ws);
      this.send(ws, { type: "hello", socketId: ws.data.id, protocol: "pi-events.v1" });
    },
    message: async (ws: ServerWebSocket<WsData>, raw: string | Buffer) => {
      await this.handleClientMessage(ws, raw.toString());
    },
    close: (ws: ServerWebSocket<WsData>) => {
      this.sockets.delete(ws);
    },
  };

  publish(message: RealtimeMessage) {
    const payload = JSON.stringify(message);
    for (const ws of this.sockets) ws.send(payload);
  }

  publishPlannerEvent(sessionId: string, event: Record<string, unknown>) {
    this.publish({ type: "planner.event", sessionId, event });
  }

  publishPlannerDone(sessionId: string, session: unknown) {
    this.publish({ type: "planner.done", sessionId, session });
  }

  publishRunEvent(event: {
    id: string;
    run_id: string;
    issue_id: string;
    agent_id: string;
    level: string;
    event_type: string;
    message: string | null;
    data: Record<string, unknown>;
    created_at: string;
  }) {
    this.publish({
      type: "run.event",
      runId: event.run_id,
      issueId: event.issue_id,
      agentId: event.agent_id,
      eventType: event.event_type,
      event,
    });
  }

  private async handleClientMessage(ws: ServerWebSocket<WsData>, raw: string) {
    let message: RealtimeMessage;
    try {
      message = JSON.parse(raw) as RealtimeMessage;
    } catch {
      this.send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (message.type === "ping") return this.send(ws, { type: "pong" });
    if (message.type === "run.cancel") {
      const ok =
        this.orchestrator?.cancelRun(
          String(message.runId ?? message.issueId ?? ""),
          "Canceled from realtime control",
        ) ?? false;
      return this.send(ws, { type: "run.cancel.result", ok });
    }
    if (message.type === "workspace.file.read") return this.readWorkspaceFile(ws, message);
    if (message.type === "workspace.tree") return this.readWorkspaceTree(ws, message);
    this.send(ws, { type: "error", message: `Unsupported message type: ${message.type}` });
  }

  private resolveWorkspacePath(message: RealtimeMessage) {
    const runId = String(message.runId ?? "");
    const relPath = String(message.path ?? "");
    const run = this.store?.getAgentRun(runId);
    if (!run?.workspace_path)
      return { ok: false as const, runId, relPath, error: "Run/workspace not found" };
    const resolved = path.resolve(run.workspace_path, relPath);
    const root = path.resolve(run.workspace_path);
    if (!resolved.startsWith(root + path.sep) && resolved !== root)
      return { ok: false as const, runId, relPath, error: "Path escapes workspace" };
    return { ok: true as const, runId, relPath, resolved, root };
  }

  private async readWorkspaceFile(ws: ServerWebSocket<WsData>, message: RealtimeMessage) {
    const workspace = this.resolveWorkspacePath(message);
    if (!workspace.ok)
      return this.send(ws, {
        type: "workspace.file.result",
        ok: false,
        error: workspace.error,
        runId: workspace.runId,
        path: workspace.relPath,
      });
    try {
      const file = Bun.file(workspace.resolved);
      if (!(await file.exists()))
        return this.send(ws, {
          type: "workspace.file.result",
          ok: false,
          error: "File not found",
          runId: workspace.runId,
          path: workspace.relPath,
        });
      const content = await file.text();
      this.send(ws, {
        type: "workspace.file.result",
        ok: true,
        runId: workspace.runId,
        path: workspace.relPath,
        content,
      });
    } catch (error) {
      this.send(ws, {
        type: "workspace.file.result",
        ok: false,
        error: String(error),
        runId: workspace.runId,
        path: workspace.relPath,
      });
    }
  }

  private async readWorkspaceTree(ws: ServerWebSocket<WsData>, message: RealtimeMessage) {
    const workspace = this.resolveWorkspacePath({ ...message, path: message.path ?? "." });
    if (!workspace.ok)
      return this.send(ws, {
        type: "workspace.tree.result",
        ok: false,
        error: workspace.error,
        runId: workspace.runId,
      });
    const root = workspace.root;
    const start = workspace.resolved;
    const maxEntries = Math.min(Number(message.maxEntries ?? 500), 2000);
    const entries: Array<{ path: string; type: "file" | "directory" }> = [];
    async function walk(dir: string) {
      if (entries.length >= maxEntries) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const name = entry.name;
        if (name === ".git" || name === "node_modules") continue;
        const absolute = path.join(dir, name);
        const relative = path.relative(root, absolute);
        entries.push({ path: relative, type: entry.isDirectory() ? "directory" : "file" });
        if (entry.isDirectory()) await walk(absolute);
        if (entries.length >= maxEntries) return;
      }
    }
    try {
      await walk(start);
      this.send(ws, {
        type: "workspace.tree.result",
        ok: true,
        runId: workspace.runId,
        entries,
        truncated: entries.length >= maxEntries,
      });
    } catch (error) {
      this.send(ws, {
        type: "workspace.tree.result",
        ok: false,
        error: String(error),
        runId: workspace.runId,
      });
    }
  }

  private send(ws: ServerWebSocket<WsData>, message: RealtimeMessage) {
    ws.send(JSON.stringify(message));
  }
}
