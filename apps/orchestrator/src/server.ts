import path from "node:path";
import type { CommentInput, KanbanStore } from "./kanban";
import type { Logger } from "./logger";
import type { Orchestrator } from "./orchestrator";
import {
  addPlannerMessageWithAgent,
  createPlannerSession,
  getPlannerSession,
  plannerDraftToCardInput,
  renderPlanningComment,
} from "./planner";
import { getWorkspaceDiff } from "./workspace-diff";
import type { RealtimeHub } from "./realtime";
import { enrichRunWithT3Links } from "./t3-links";

const columns = ["Todo", "In Progress", "Review", "Done"];
const distRoot = path.resolve(process.cwd(), "dist");

export function serveBoard(
  store: KanbanStore,
  orchestrator: Orchestrator,
  logger: Logger,
  port: number,
  realtime: RealtimeHub,
) {
  const server = Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        if (realtime.upgrade(request)) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      try {
        if (url.pathname === "/api/cards" && request.method === "GET")
          return json({ cards: store.listCards(), columns });
        if (url.pathname === "/api/cards" && request.method === "POST") {
          const body = await request.json();
          const card = store.createCard(normalizeCardInput(body));
          orchestrator.requestTick();
          return json(card, 201);
        }

        const cardMatch = url.pathname.match(/^\/api\/cards\/([^/]+)$/);
        if (cardMatch && request.method === "PATCH") {
          const body = await request.json();
          const card = store.updateCard(cardMatch[1]!, normalizeCardInput(body));
          if (card) orchestrator.requestTick();
          return card ? json(card) : json({ error: "Card not found" }, 404);
        }
        if (cardMatch && request.method === "DELETE") {
          return json({ ok: store.deleteCard(cardMatch[1]!) });
        }

        const moveMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/move$/);
        if (moveMatch && request.method === "POST") {
          const body = await request.json();
          const position = Number(body.position);
          const card = store.moveCard(
            moveMatch[1]!,
            String(body.state ?? "Todo"),
            Number.isFinite(position) ? position : undefined,
          );
          if (card) orchestrator.requestTick();
          return card ? json(card) : json({ error: "Card not found" }, 404);
        }

        const commentsMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/comments$/);
        if (commentsMatch && request.method === "GET") {
          return json({ comments: store.listComments(commentsMatch[1]!) });
        }
        if (commentsMatch && request.method === "POST") {
          const body = await request.json();
          const comment = store.addComment(commentsMatch[1]!, normalizeCommentInput(body));
          return comment ? json(comment, 201) : json({ error: "Comment not created" }, 400);
        }

        if (url.pathname === "/api/orchestrator/status") return json(orchestrator.status());
        if (url.pathname === "/api/orchestrator/runs") {
          const limit = Number(url.searchParams.get("limit") ?? 100);
          return json({
            runs: store
              .listAgentRuns(undefined, Number.isFinite(limit) ? limit : 100)
              .map((run) => enrichRunWithT3Links(run, orchestrator.resolvedConfig())),
          });
        }
        const cardRunsMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/runs$/);
        if (cardRunsMatch && request.method === "GET") {
          return json({
            runs: store
              .listAgentRuns(cardRunsMatch[1]!, 50)
              .map((run) => enrichRunWithT3Links(run, orchestrator.resolvedConfig())),
          });
        }
        const runDiffMatch = url.pathname.match(/^\/api\/orchestrator\/runs\/([^/]+)\/diff$/);
        if (runDiffMatch && request.method === "GET") {
          const run = store.getAgentRun(runDiffMatch[1]!);
          if (!run) return json({ error: "Run not found" }, 404);
          return json(await getWorkspaceDiff(run.workspace_path));
        }
        const cardDiffMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/diff$/);
        if (cardDiffMatch && request.method === "GET") {
          const [run] = store.listAgentRuns(cardDiffMatch[1]!, 1);
          if (!run) return json(await getWorkspaceDiff(null));
          return json(await getWorkspaceDiff(run.workspace_path));
        }
        if (url.pathname === "/api/orchestrator/logs") {
          const limit = Number(url.searchParams.get("limit") ?? 200);
          return json({ logs: logger.recent(Number.isFinite(limit) ? limit : 200) });
        }
        if (url.pathname === "/api/workflow" && request.method === "GET") {
          return json(await orchestrator.workflowDocument());
        }
        if (url.pathname === "/api/workflow" && request.method === "PUT") {
          const body = await request.json();
          const source = typeof body.source === "string" ? body.source : "";
          if (!source.trim()) return json({ error: "Workflow source is required" }, 400);
          return json(await orchestrator.saveWorkflow(source));
        }
        if (url.pathname === "/api/t3/projects" && request.method === "GET") {
          return json(await orchestrator.t3Projects());
        }
        if (url.pathname === "/api/t3/projects" && request.method === "POST") {
          const body = await request.json();
          const title = typeof body.title === "string" ? body.title.trim() : "";
          const workspaceRoot =
            typeof body.workspaceRoot === "string" ? body.workspaceRoot.trim() : "";
          if (!title) return json({ error: "Project title is required" }, 400);
          if (!workspaceRoot) return json({ error: "Workspace root is required" }, 400);
          return json(
            { project: await orchestrator.createT3Project({ title, workspaceRoot }) },
            201,
          );
        }
        if (url.pathname === "/api/t3/selected-project" && request.method === "PUT") {
          const body = await request.json();
          const rawProjectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
          return json(await orchestrator.selectT3Project(rawProjectId || null));
        }

        if (url.pathname === "/api/planner/sessions" && request.method === "POST") {
          return json(createPlannerSession(), 201);
        }
        const plannerMessageMatch = url.pathname.match(
          /^\/api\/planner\/sessions\/([^/]+)\/messages$/,
        );
        if (plannerMessageMatch && request.method === "POST") {
          const body = await request.json();
          const session = await addPlannerMessageWithAgent(
            plannerMessageMatch[1]!,
            String(body.message ?? ""),
          );
          return session ? json(session) : json({ error: "Planner session not found" }, 404);
        }
        const plannerCreateMatch = url.pathname.match(/^\/api\/planner\/sessions\/([^/]+)\/card$/);
        if (plannerCreateMatch && request.method === "POST") {
          const session = getPlannerSession(plannerCreateMatch[1]!);
          if (!session) return json({ error: "Planner session not found" }, 404);
          if (!session.draft.ready)
            return json({ error: "Planner draft is not ready", draft: session.draft }, 400);
          const card = store.createCard(plannerDraftToCardInput(session.draft));
          orchestrator.requestTick();
          store.addComment(card.id, {
            author: "planner-agent",
            kind: "planning",
            body: renderPlanningComment(session),
          });
          logger.info("planner_card_created", {
            issue_id: card.id,
            identifier: card.identifier,
            title: card.title,
          });
          return json({ card }, 201);
        }

        if (url.pathname.startsWith("/api/")) {
          return json({ error: `API route not found: ${request.method} ${url.pathname}` }, 404);
        }

        return serveStatic(url.pathname);
      } catch (error) {
        logger.error("http_request_failed", { path: url.pathname, error: String(error) });
        return json({ error: String(error) }, 500);
      }
    },
    websocket: realtime.websocket,
  });
  realtime.attach(server, store, orchestrator);
  logger.info("server_started", { url: `http://localhost:${server.port}`, websocket: "/ws" });
  return server;
}

function normalizeCardInput(body: unknown) {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    title: String(record.title ?? "").trim(),
    description: typeof record.description === "string" ? record.description : null,
    priority:
      record.priority === null || record.priority === "" ? null : Number(record.priority ?? null),
    state: typeof record.state === "string" ? record.state : undefined,
    labels:
      typeof record.labels === "string"
        ? record.labels
            .split(",")
            .map((label) => label.trim())
            .filter(Boolean)
        : Array.isArray(record.labels)
          ? record.labels.filter((label): label is string => typeof label === "string")
          : [],
    blocked_by: Array.isArray(record.blocked_by) ? record.blocked_by : [],
    extra_data: normalizeExtraData(record.extra_data),
  };
}

function normalizeCommentInput(body: unknown): CommentInput {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const kind =
    typeof record.kind === "string" && isCommentKind(record.kind) ? record.kind : "comment";
  return {
    author: typeof record.author === "string" ? record.author : "user",
    body: String(record.body ?? ""),
    kind,
  };
}

function isCommentKind(kind: string): kind is NonNullable<CommentInput["kind"]> {
  return ["comment", "planning"].includes(kind);
}

function normalizeExtraData(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { note: value };
  }
}

function serveStatic(pathname: string) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(distRoot, `.${safePath}`);
  if (!resolved.startsWith(distRoot)) return json({ error: "Not found" }, 404);

  const file = Bun.file(resolved);
  if (file.size > 0)
    return new Response(file, { headers: { "content-type": contentType(resolved) } });

  const fallback = Bun.file(path.join(distRoot, "index.html"));
  if (fallback.size > 0)
    return new Response(fallback, { headers: { "content-type": "text/html" } });

  return new Response("UI has not been built. Run `bun run build:ui` first.", {
    status: 503,
    headers: { "content-type": "text/plain" },
  });
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".js")) return "application/javascript";
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
