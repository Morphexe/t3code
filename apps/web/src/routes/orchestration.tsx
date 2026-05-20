import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  ActivityIcon,
  BotIcon,
  Code2Icon,
  Columns3Icon,
  EyeIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GitCompareIcon,
  GripVerticalIcon,
  MessageSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  SendIcon,
  WorkflowIcon,
} from "lucide-react";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent, ReactNode } from "react";

import { PatchDiffViewer } from "../components/DiffPanel";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { cn } from "../lib/utils";

const ORCHESTRATOR_API = "/orchestrator-api";
const ORCHESTRATOR_WS = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/orchestrator-ws`;

type Card = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  position: number;
  labels: string[];
  comments: CardComment[];
  comment_count: number;
};

type CardComment = {
  id: string;
  author: string;
  body: string;
  kind: "comment" | "planning" | "agent" | "result";
  created_at: string;
};

type AgentRun = {
  id: string;
  issue_id: string;
  identifier: string;
  agent_id: string;
  status: string;
  attempt?: number | null;
  command: string;
  model?: string | null;
  profile?: string | null;
  workspace_path: string | null;
  workspace_exists?: boolean;
  pid?: number | null;
  summary: string | null;
  error: string | null;
  moved_to_state?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  runtime_ms?: number;
  started_at: string;
  finished_at: string | null;
  events: AgentRunEvent[];
  t3_thread_id?: string | null;
  t3_chat_url?: string | null;
  t3_embed_url?: string | null;
  t3Links?: { threadUrl: string; threadId: string } | null;
};

type AgentRunEvent = {
  id: string;
  level: "debug" | "info" | "warn" | "error";
  event_type: string;
  message: string | null;
  data: Record<string, unknown>;
  created_at: string;
};

type Status = {
  scheduler?: {
    stopped: boolean;
    tick_in_progress: boolean;
    current_tick_started_at: string | null;
    next_tick_due_at: string | null;
    last_tick_started_at: string | null;
    last_tick_completed_at: string | null;
    last_tick_error: string | null;
    last_tick_candidate_count: number;
    last_tick_dispatched_count: number;
  };
  running: unknown[];
  claimed: string[];
  retries: unknown[];
  completed: string[];
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    runtime_ms: number;
  };
  config: { active_states: string[]; max_concurrent_agents: number } | null;
};

type T3Project = {
  id: string;
  title: string;
  workspaceRoot: string;
  deletedAt?: string | null;
};

type WorkflowDocument = {
  path: string;
  source: string;
  updatedAt: string;
};

type WorkspaceDiff = {
  workspace_path: string | null;
  available: boolean;
  is_git_worktree: boolean;
  files: { path: string; status: string }[];
  all_files: string[];
  stat: string;
  patch: string;
  error: string | null;
};

type PlannerMessage = {
  id: string;
  role: "user" | "assistant";
  body: string;
  created_at: string;
};

type PlannerDraft = {
  title: string;
  goal: string;
  acceptance_criteria: string[];
  labels: string[];
  priority: number | null;
  constraints: string[];
  notes: string[];
  state: string;
  ready: boolean;
};

type PlannerSession = {
  id: string;
  messages: PlannerMessage[];
  draft: PlannerDraft;
  created_at: string;
  updated_at: string;
};

type LogRecord = {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  message?: string;
  error?: string;
  agent_id?: string;
  identifier?: string;
  data?: Record<string, unknown>;
};

type ViewTab = "board" | "workflow" | "activity";

type CardDraft = {
  id?: string;
  title: string;
  description: string;
  state: string;
  priority: string;
  labels: string;
  comments: CardComment[];
  newComment: string;
  newCommentKind: CardComment["kind"];
};

type OrchestrationSearch = {
  projectId?: string;
  title?: string;
  workspaceRoot?: string;
};

export const Route = createFileRoute("/orchestration")({
  validateSearch: (search: Record<string, unknown>): OrchestrationSearch => {
    const parsed: OrchestrationSearch = {};
    if (typeof search.projectId === "string") parsed.projectId = search.projectId;
    if (typeof search.title === "string") parsed.title = search.title;
    if (typeof search.workspaceRoot === "string") parsed.workspaceRoot = search.workspaceRoot;
    return parsed;
  },
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: OrchestrationRouteView,
});

function OrchestrationRouteView() {
  const routeSearch = Route.useSearch();
  const [tab, setTab] = useState<ViewTab>("board");
  const [cards, setCards] = useState<Card[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [projects, setProjects] = useState<T3Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowDocument | null>(null);
  const [workflowSource, setWorkflowSource] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [savingWorkflow, setSavingWorkflow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardDraft, setCardDraft] = useState<CardDraft | null>(null);
  const [selectedRun, setSelectedRun] = useState<AgentRun | null>(null);
  const [selectedLog, setSelectedLog] = useState<LogRecord | null>(null);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [planner, setPlanner] = useState<PlannerSession | null>(null);
  const [plannerInput, setPlannerInput] = useState("");
  const [plannerBusy, setPlannerBusy] = useState(false);
  const [plannerError, setPlannerError] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const routeProjectRoot = routeSearch.workspaceRoot?.trim() ?? "";
  const routeProject = useMemo(() => projectFromRouteSearch(routeSearch), [routeSearch]);
  const scopedCards = useMemo(() => {
    if (!selectedProject) return cards;
    return cards.filter((card) => cardBelongsToProject(card, runs, selectedProject));
  }, [cards, runs, selectedProject]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [cardsPayload, statusPayload, runsPayload, logsPayload] = await Promise.all([
        apiJson<{ cards: Card[]; columns: string[] }>("/cards"),
        apiJson<Status>("/orchestrator/status"),
        apiJson<{ runs: AgentRun[] }>("/orchestrator/runs?limit=100"),
        apiJson<{ logs: LogRecord[] }>("/orchestrator/logs?limit=200"),
      ]);
      const projectsPayload = await apiJson<{
        projects: T3Project[];
        selectedProjectId: string | null;
      }>("/t3/projects").catch(() => ({
        projects: routeProject ? [routeProject] : [],
        selectedProjectId: routeProject?.id ?? null,
      }));
      const nextProjects =
        routeProject && !findRouteProject(projectsPayload.projects, routeSearch)
          ? [...projectsPayload.projects, routeProject]
          : projectsPayload.projects;
      setCards(cardsPayload.cards);
      setColumns(cardsPayload.columns);
      setStatus(statusPayload);
      setRuns(runsPayload.runs);
      setLogs(logsPayload.logs);
      setProjects(nextProjects);
      if (routeProjectRoot) {
        setSelectedProjectId(findRouteProject(nextProjects, routeSearch)?.id ?? null);
      } else {
        setSelectedProjectId(projectsPayload.selectedProjectId);
      }
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRefreshing(false);
    }
  }, [routeProject, routeProjectRoot, routeSearch]);

  const loadWorkflow = useCallback(async () => {
    try {
      const document = await apiJson<WorkflowDocument>("/workflow");
      setWorkflow(document);
      setWorkflowSource(document.source);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadWorkflow();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [loadWorkflow, refresh]);

  useEffect(() => {
    if (!routeProjectRoot) return;
    if (findRouteProject(projects, routeSearch)) return;
    let canceled = false;
    const title =
      routeSearch.title?.trim() || routeProjectRoot.split("/").toReversed()[0] || "T3 project";
    void apiJson<{ project: T3Project }>("/t3/projects", {
      method: "POST",
      body: JSON.stringify({ title, workspaceRoot: routeProjectRoot }),
    })
      .then(({ project }) => {
        if (canceled) return;
        setProjects((current) =>
          current.some((entry) => entry.id === project.id) ? current : [...current, project],
        );
        setSelectedProjectId(project.id);
      })
      .catch((caught) => {
        if (!canceled) setError(errorMessage(caught));
      });
    return () => {
      canceled = true;
    };
  }, [projects, routeProjectRoot, routeSearch]);

  useEffect(() => {
    let refreshTimer: number | null = null;
    const socket = new WebSocket(ORCHESTRATOR_WS);
    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          type?: string;
          session?: PlannerSession;
          sessionId?: string;
        };
        if (payload.type === "run.event") {
          if (refreshTimer) window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => void refresh(), 500);
        }
        if (payload.type === "planner.done" && payload.session) {
          setPlanner((current) =>
            current?.id === payload.sessionId ? (payload.session ?? current) : current,
          );
          setPlannerBusy(false);
        }
      } catch {
        // Polling remains the fallback for malformed realtime payloads.
      }
    });
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      socket.close();
    };
  }, [refresh]);

  async function saveCard(draft: CardDraft) {
    const payload = {
      title: draft.title,
      description: draft.description || null,
      state: draft.state,
      priority: draft.priority ? Number(draft.priority) : null,
      labels: draft.labels,
    };
    await apiJson(draft.id ? `/cards/${draft.id}` : "/cards", {
      method: draft.id ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    setCardDraft(null);
    await refresh();
  }

  async function addCardComment(draft: CardDraft) {
    if (!draft.id || !draft.newComment.trim()) return;
    const comment = await apiJson<CardComment>(`/cards/${draft.id}/comments`, {
      method: "POST",
      body: JSON.stringify({
        author: "user",
        kind: draft.newCommentKind,
        body: draft.newComment.trim(),
      }),
    });
    setCardDraft({ ...draft, comments: [...draft.comments, comment], newComment: "" });
    await refresh();
  }

  async function moveCard(card: Card, state: string, position?: number) {
    await apiJson(`/cards/${card.id}/move`, {
      method: "POST",
      body: JSON.stringify({ state, position }),
    });
    await refresh();
  }

  async function saveWorkflow() {
    setSavingWorkflow(true);
    try {
      const saved = await apiJson<WorkflowDocument>("/workflow", {
        method: "PUT",
        body: JSON.stringify({ source: workflowSource }),
      });
      setWorkflow(saved);
      setWorkflowSource(saved.source);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSavingWorkflow(false);
    }
  }

  async function openPlanner() {
    setPlannerOpen(true);
    if (planner) return;
    setPlannerBusy(true);
    setPlannerError(null);
    try {
      setPlanner(await apiJson<PlannerSession>("/planner/sessions", { method: "POST" }));
    } catch (caught) {
      setPlannerError(errorMessage(caught));
    } finally {
      setPlannerBusy(false);
    }
  }

  async function sendPlannerMessage() {
    if (!planner || !plannerInput.trim()) return;
    const message = plannerInput.trim();
    setPlannerInput("");
    setPlannerBusy(true);
    setPlannerError(null);
    try {
      setPlanner(
        await apiJson<PlannerSession>(`/planner/sessions/${planner.id}/messages`, {
          method: "POST",
          body: JSON.stringify({ message }),
        }),
      );
    } catch (caught) {
      setPlannerError(errorMessage(caught));
      setPlannerInput(message);
    } finally {
      setPlannerBusy(false);
    }
  }

  async function createPlannedCard() {
    if (!planner?.draft.ready) return;
    setPlannerBusy(true);
    try {
      await apiJson<{ card: Card }>(`/planner/sessions/${planner.id}/card`, { method: "POST" });
      setPlannerOpen(false);
      setPlanner(null);
      setPlannerInput("");
      await refresh();
    } catch (caught) {
      setPlannerError(errorMessage(caught));
    } finally {
      setPlannerBusy(false);
    }
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-background">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
              <WorkflowIcon className="size-4" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">Orchestration</h1>
              <p className="truncate text-[11px] text-muted-foreground/70">
                {selectedProject?.title ?? "All orchestration"} · {scopedCards.length} cards
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void openPlanner()}>
              <BotIcon />
              <span>Plan ticket</span>
            </Button>
            {(["board", "workflow", "activity"] as const).map((entry) => (
              <Button
                key={entry}
                variant={tab === entry ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setTab(entry)}
              >
                {entry === "board" ? (
                  <Columns3Icon />
                ) : entry === "workflow" ? (
                  <FileTextIcon />
                ) : (
                  <ActivityIcon />
                )}
                <span className="capitalize">{entry}</span>
              </Button>
            ))}
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
            </Button>
          </div>
        </header>

        <main className="min-w-0 overflow-auto">
          <StatusStrip status={status} error={error} />
          {tab === "board" ? (
            <BoardView
              cards={scopedCards}
              columns={columns}
              runs={runs}
              onAdd={() =>
                setCardDraft({
                  title: "",
                  description: "",
                  state: columns[0] ?? "Todo",
                  priority: "",
                  labels: "",
                  comments: [],
                  newComment: "",
                  newCommentKind: "comment",
                })
              }
              onEdit={(card) =>
                setCardDraft({
                  id: card.id,
                  title: card.title,
                  description: card.description ?? "",
                  state: card.state,
                  priority: card.priority?.toString() ?? "",
                  labels: card.labels.join(", "),
                  comments: card.comments,
                  newComment: "",
                  newCommentKind: "comment",
                })
              }
              onMove={(card, state, position) => void moveCard(card, state, position)}
              onOpenRun={setSelectedRun}
            />
          ) : tab === "workflow" ? (
            <WorkflowView
              workflow={workflow}
              source={workflowSource}
              setSource={setWorkflowSource}
              saving={savingWorkflow}
              onSave={() => void saveWorkflow()}
            />
          ) : (
            <ActivityView
              runs={runs}
              logs={logs}
              onOpenRun={setSelectedRun}
              onOpenLog={setSelectedLog}
            />
          )}
        </main>
      </div>

      {cardDraft ? (
        <CardDialog
          draft={cardDraft}
          columns={columns}
          onChange={setCardDraft}
          onClose={() => setCardDraft(null)}
          onSave={(draft) => void saveCard(draft)}
          onAddComment={(draft) => void addCardComment(draft)}
        />
      ) : null}
      {selectedRun ? <RunDialog run={selectedRun} onClose={() => setSelectedRun(null)} /> : null}
      {selectedLog ? <LogDialog log={selectedLog} onClose={() => setSelectedLog(null)} /> : null}
      {plannerOpen ? (
        <PlannerDialog
          session={planner}
          input={plannerInput}
          busy={plannerBusy}
          error={plannerError}
          onInput={setPlannerInput}
          onSend={() => void sendPlannerMessage()}
          onCreate={() => void createPlannedCard()}
          onRestart={() => {
            setPlanner(null);
            setPlannerInput("");
            void openPlanner();
          }}
          onClose={() => setPlannerOpen(false)}
        />
      ) : null}
    </SidebarInset>
  );
}

function StatusStrip({ status, error }: { status: Status | null; error: string | null }) {
  const scheduler = status?.scheduler;
  const nextTickLabel = scheduler?.tick_in_progress
    ? "Tick running"
    : scheduler?.next_tick_due_at
      ? `Next tick ${formatShortRelativeTime(scheduler.next_tick_due_at)}`
      : "Tick pending";
  return (
    <div className="flex h-10 items-center gap-4 overflow-x-auto border-b border-border bg-muted/25 px-4 text-xs">
      <span className={cn("font-medium", scheduler?.tick_in_progress && "text-primary")}>
        {nextTickLabel}
      </span>
      <span>
        Running <strong>{status?.running.length ?? 0}</strong>
        <span className="text-muted-foreground">
          /{status?.config?.max_concurrent_agents ?? "—"}
        </span>
      </span>
      <span>
        Queued <strong>{status?.retries.length ?? 0}</strong>
      </span>
      <span>
        Done <strong>{status?.completed.length ?? 0}</strong>
      </span>
      <span>
        Tokens <strong>{status?.codex_totals.total_tokens ?? 0}</strong>
      </span>
      {scheduler ? (
        <span className="hidden whitespace-nowrap text-muted-foreground md:inline">
          Last tick {scheduler.last_tick_candidate_count} candidates ·{" "}
          {scheduler.last_tick_dispatched_count} dispatched
        </span>
      ) : null}
      {status?.config?.active_states ? (
        <span className="ml-auto hidden truncate font-mono text-[10px] text-muted-foreground lg:block">
          Active {status.config.active_states.join(", ")}
        </span>
      ) : null}
      {error ? <span className="ml-auto truncate text-destructive">{error}</span> : null}
    </div>
  );
}

function formatShortRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "soon";
  const deltaMs = timestamp - Date.now();
  const seconds = Math.max(0, Math.round(deltaMs / 1000));
  if (seconds <= 1) return "now";
  return `in ${seconds}s`;
}

function BoardView({
  cards,
  columns,
  runs,
  onAdd,
  onEdit,
  onMove,
  onOpenRun,
}: {
  cards: Card[];
  columns: string[];
  runs: AgentRun[];
  onAdd: () => void;
  onEdit: (card: Card) => void;
  onMove: (card: Card, state: string, position?: number) => void;
  onOpenRun: (run: AgentRun) => void;
}) {
  const [draggedCardId, setDraggedCardId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ state: string; index: number } | null>(null);
  const cardsById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);

  function moveDraggedCard(state: string, index: number) {
    if (!draggedCardId) return;
    const draggedCard = cardsById.get(draggedCardId);
    if (!draggedCard) return;
    onMove(draggedCard, state, index);
    setDraggedCardId(null);
    setDropTarget(null);
  }

  return (
    <section className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Board</h2>
        <Button size="sm" onClick={onAdd}>
          <PlusIcon className="size-3.5" />
          New card
        </Button>
      </div>
      <div className="grid auto-cols-[minmax(270px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
        {columns.map((column) => {
          const columnCards = cards
            .filter((card) => card.state === column)
            .toSorted(
              (a, b) => a.position - b.position || a.identifier.localeCompare(b.identifier),
            );
          return (
            <div
              key={column}
              className={cn(
                "min-h-[58vh] rounded-xl border border-border bg-card/60 transition-colors",
                dropTarget?.state === column && "border-primary/60 bg-primary/5",
              )}
              onDragOver={(event) => {
                if (!draggedCardId) return;
                event.preventDefault();
                setDropTarget({ state: column, index: columnCards.length });
              }}
              onDrop={(event) => {
                event.preventDefault();
                moveDraggedCard(
                  column,
                  dropTarget?.state === column ? dropTarget.index : columnCards.length,
                );
              }}
            >
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-xs font-semibold">{column}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {columnCards.length}
                </span>
              </div>
              <div className="space-y-2 p-2">
                {columnCards.map((card, index) => (
                  <KanbanCard
                    key={card.id}
                    card={card}
                    columns={columns}
                    runs={runs.filter((run) => run.issue_id === card.id)}
                    dragging={draggedCardId === card.id}
                    dropBefore={dropTarget?.state === column && dropTarget.index === index}
                    onDragStart={() => setDraggedCardId(card.id)}
                    onDragEnd={() => {
                      setDraggedCardId(null);
                      setDropTarget(null);
                    }}
                    onDragOver={(event) => {
                      if (!draggedCardId || draggedCardId === card.id) return;
                      event.preventDefault();
                      event.stopPropagation();
                      setDropTarget({ state: column, index });
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      moveDraggedCard(column, index);
                    }}
                    onEdit={() => onEdit(card)}
                    onMove={(state) => onMove(card, state)}
                    onOpenRun={onOpenRun}
                  />
                ))}
                {draggedCardId &&
                dropTarget?.state === column &&
                dropTarget.index === columnCards.length ? (
                  <div className="h-10 rounded-lg border border-dashed border-primary/70 bg-primary/10" />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function KanbanCard({
  card,
  columns,
  runs,
  onEdit,
  onMove,
  onOpenRun,
  dragging,
  dropBefore,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  card: Card;
  columns: string[];
  runs: AgentRun[];
  onEdit: () => void;
  onMove: (state: string) => void;
  onOpenRun: (run: AgentRun) => void;
  dragging: boolean;
  dropBefore: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}) {
  const latestRun = runs[0];
  return (
    <article
      draggable
      className={cn(
        "group rounded-lg border border-border bg-background shadow-xs transition",
        dragging && "opacity-45",
        dropBefore && "ring-2 ring-primary/70",
      )}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", card.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 border-b border-border/70 p-2.5">
        <button
          className="mt-0.5 cursor-grab rounded text-muted-foreground transition hover:bg-accent hover:text-foreground active:cursor-grabbing"
          title="Drag card"
          type="button"
        >
          <GripVerticalIcon className="size-4" />
        </button>
        <button className="min-w-0 text-left" onClick={onEdit}>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-muted-foreground">{card.identifier}</span>
            {card.priority ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">P{card.priority}</span>
            ) : null}
          </div>
          <h3 className="mt-0.5 line-clamp-2 text-sm font-medium leading-snug">{card.title}</h3>
        </button>
        {latestRun ? (
          <button
            className={cn(
              "self-start rounded px-1.5 py-1 font-mono text-[10px]",
              latestRun.error
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground",
            )}
            onClick={() => onOpenRun(latestRun)}
          >
            {latestRun.status}
          </button>
        ) : null}
      </div>
      <div className="space-y-2 p-2.5">
        {card.description ? (
          <p className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
            {card.description}
          </p>
        ) : null}
        {latestRun?.summary || latestRun?.error ? (
          <button
            className={cn(
              "line-clamp-2 w-full rounded-md border px-2 py-1.5 text-left text-[11px] leading-relaxed",
              latestRun.error
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-border bg-muted/40 text-muted-foreground",
            )}
            onClick={() => onOpenRun(latestRun)}
          >
            {latestRun.error ?? latestRun.summary}
          </button>
        ) : null}
        {card.labels.length ? (
          <div className="flex flex-wrap gap-1">
            {card.labels.map((label) => (
              <span
                key={label}
                className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t border-border/70 p-2.5">
        <select
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
          value={card.state}
          onChange={(event) => onMove(event.target.value)}
        >
          {columns.map((column) => (
            <option key={column} value={column}>
              {column}
            </option>
          ))}
        </select>
        {card.comment_count ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
            <MessageSquareIcon className="size-3" />
            {card.comment_count}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function WorkflowView({
  workflow,
  source,
  setSource,
  saving,
  onSave,
}: {
  workflow: WorkflowDocument | null;
  source: string;
  setSource: (source: string) => void;
  saving: boolean;
  onSave: () => void;
}) {
  const [mode, setMode] = useState<"source" | "preview">("source");
  const workflowParts = useMemo(() => splitWorkflowSource(source), [source]);
  const hasChanges = source !== workflow?.source;
  return (
    <section className="grid h-[calc(100vh-5.5rem)] grid-rows-[auto_minmax(0,1fr)] p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Workflow</h2>
            <p className="truncate font-mono text-[10px] text-muted-foreground">
              {workflow?.path ?? "WORKFLOW.md"}
            </p>
          </div>
          {hasChanges ? (
            <span className="rounded bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">
              Unsaved
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex h-8 items-center rounded-md border border-border bg-background p-0.5">
            <button
              type="button"
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground transition-colors",
                mode === "source" && "bg-accent text-foreground",
              )}
              onClick={() => setMode("source")}
            >
              <Code2Icon className="size-3.5" />
              Source
            </button>
            <button
              type="button"
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground transition-colors",
                mode === "preview" && "bg-accent text-foreground",
              )}
              onClick={() => setMode("preview")}
            >
              <EyeIcon className="size-3.5" />
              Preview
            </button>
          </div>
          <Button size="sm" disabled={saving || !hasChanges} onClick={onSave}>
            <SaveIcon className="size-3.5" />
            {saving ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
      <div
        className="min-h-0 overflow-hidden rounded-lg border border-border bg-card"
        data-color-mode="dark"
      >
        {mode === "source" ? (
          <MDEditor
            value={source}
            onChange={(value) => setSource(value ?? "")}
            height="100%"
            preview="edit"
          />
        ) : (
          <WorkflowPreview parts={workflowParts} />
        )}
      </div>
    </section>
  );
}

function WorkflowPreview({ parts }: { parts: WorkflowParts }) {
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(280px,0.42fr)_minmax(0,1fr)] overflow-hidden">
      <section className="min-h-0 border-r border-border bg-background/40">
        <div className="border-b border-border px-3 py-2 text-xs font-semibold">Configuration</div>
        <pre className="h-full min-h-0 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {parts.frontmatter || "No workflow configuration block."}
        </pre>
      </section>
      <section className="min-h-0 overflow-auto bg-background/20">
        <div className="border-b border-border px-3 py-2 text-xs font-semibold">
          Prompt template
        </div>
        <div className="workflow-preview-content px-5 py-4">
          <MDEditor.Markdown source={parts.body || "No prompt template content."} />
        </div>
      </section>
    </div>
  );
}

type WorkflowParts = {
  frontmatter: string;
  body: string;
};

function splitWorkflowSource(source: string): WorkflowParts {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: "", body: normalized };
  }
  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) {
    return { frontmatter: normalized.slice(4).trim(), body: "" };
  }
  return {
    frontmatter: normalized.slice(4, endIndex).trim(),
    body: normalized.slice(endIndex + 4).trimStart(),
  };
}

function ActivityView({
  runs,
  logs,
  onOpenRun,
  onOpenLog,
}: {
  runs: AgentRun[];
  logs: LogRecord[];
  onOpenRun: (run: AgentRun) => void;
  onOpenLog: (log: LogRecord) => void;
}) {
  return (
    <section className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.7fr)]">
      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-3 py-2 text-xs font-semibold">Runs</div>
        <div className="max-h-[70vh] overflow-auto">
          {runs.map((run) => (
            <button
              key={run.id}
              className="grid w-full grid-cols-[120px_minmax(0,1fr)_120px] gap-3 border-b border-border px-3 py-2 text-left text-xs hover:bg-accent"
              onClick={() => onOpenRun(run)}
            >
              <span className="font-mono text-muted-foreground">{run.identifier}</span>
              <span className="truncate">{run.summary ?? run.error ?? run.command}</span>
              <span className={run.error ? "text-destructive" : "text-muted-foreground"}>
                {run.status}
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-3 py-2 text-xs font-semibold">Logs</div>
        <div className="max-h-[70vh] overflow-auto font-mono text-[11px]">
          {logs.map((log) => (
            <button
              key={logRecordKey(log)}
              className="grid w-full grid-cols-[74px_52px_minmax(0,1fr)] gap-2 border-b border-border px-3 py-1.5 text-left hover:bg-accent"
              onClick={() => onOpenLog(log)}
            >
              <span className="text-muted-foreground">{new Date(log.ts).toLocaleTimeString()}</span>
              <span
                className={log.level === "error" ? "text-destructive" : "text-muted-foreground"}
              >
                {log.level}
              </span>
              <span className="truncate">{log.message ?? log.error ?? log.event}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function CardDialog(props: {
  draft: CardDraft;
  columns: string[];
  onChange: (draft: CardDraft) => void;
  onClose: () => void;
  onSave: (draft: CardDraft) => void;
  onAddComment: (draft: CardDraft) => void;
}) {
  const { draft, columns, onChange } = props;
  return (
    <Modal title={draft.id ? "Edit card" : "New card"} onClose={props.onClose}>
      <div className="space-y-3">
        <Field label="Title">
          <input
            className="form-input"
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
          />
        </Field>
        <Field label="Description">
          <textarea
            className="form-input min-h-28 py-2"
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="State">
            <select
              className="form-input"
              value={draft.state}
              onChange={(e) => onChange({ ...draft, state: e.target.value })}
            >
              {columns.map((column) => (
                <option key={column}>{column}</option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <input
              className="form-input"
              value={draft.priority}
              onChange={(e) => onChange({ ...draft, priority: e.target.value })}
            />
          </Field>
          <Field label="Labels">
            <input
              className="form-input"
              value={draft.labels}
              onChange={(e) => onChange({ ...draft, labels: e.target.value })}
            />
          </Field>
        </div>
        {draft.id ? (
          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-xs font-semibold">Comments</span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {draft.comments.length}
              </span>
            </div>
            <div className="max-h-48 overflow-auto p-2">
              {draft.comments.length ? (
                draft.comments.map((comment) => (
                  <article key={comment.id} className="border-b border-border py-2 last:border-0">
                    <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="font-medium text-foreground">{comment.author}</span>
                      <span>{comment.kind}</span>
                      <span>{new Date(comment.created_at).toLocaleString()}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed">{comment.body}</p>
                  </article>
                ))
              ) : (
                <p className="py-3 text-center text-xs text-muted-foreground">No comments yet.</p>
              )}
            </div>
            <div className="grid gap-2 border-t border-border p-2">
              <textarea
                className="form-input min-h-20 py-2"
                value={draft.newComment}
                onChange={(e) => onChange({ ...draft, newComment: e.target.value })}
              />
              <div className="flex justify-end gap-2">
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={draft.newCommentKind}
                  onChange={(e) =>
                    onChange({
                      ...draft,
                      newCommentKind: e.target.value as CardComment["kind"],
                    })
                  }
                >
                  <option value="comment">comment</option>
                  <option value="planning">planning</option>
                </select>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!draft.newComment.trim()}
                  onClick={() => props.onAddComment(draft)}
                >
                  <MessageSquareIcon className="size-3.5" />
                  Add comment
                </Button>
              </div>
            </div>
          </section>
        ) : null}
      </div>
      <ModalFooter
        onClose={props.onClose}
        onSave={() => props.onSave(draft)}
        disabled={!draft.title.trim()}
      />
    </Modal>
  );
}

function RunDialog({ run, onClose }: { run: AgentRun; onClose: () => void }) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const loadDiff = useCallback(async () => {
    setDiffLoading(true);
    setDiffError(null);
    try {
      setDiff(await apiJson<WorkspaceDiff>(`/orchestrator/runs/${run.id}/diff`));
    } catch (caught) {
      setDiffError(errorMessage(caught));
    } finally {
      setDiffLoading(false);
    }
  }, [run.id]);

  useEffect(() => {
    if (run.workspace_path) void loadDiff();
  }, [loadDiff, run.workspace_path]);

  const t3ChatUrl = run.t3_chat_url ?? run.t3Links?.threadUrl;
  return (
    <Modal title={`${run.identifier} · ${run.status}`} onClose={onClose} wide>
      <div className="grid max-h-[82vh] gap-3 overflow-auto">
        {t3ChatUrl ? (
          <Button
            size="sm"
            variant="outline"
            render={<a href={t3ChatUrl} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon className="size-3.5" />
            T3 chat
          </Button>
        ) : null}
        <RunDiffPanel diff={diff} loading={diffLoading} error={diffError} onRefresh={loadDiff} />
        <section className="rounded-lg border border-border">
          <div className="border-b border-border px-3 py-2 text-xs font-semibold">Events</div>
          <div className="max-h-56 overflow-auto">
            {run.events.length ? (
              run.events.map((event) => (
                <details key={event.id} className="border-b border-border px-3 py-2 text-xs">
                  <summary className="cursor-pointer">
                    <span className="font-mono text-muted-foreground">
                      {new Date(event.created_at).toLocaleTimeString()}
                    </span>{" "}
                    <span className={event.level === "error" ? "text-destructive" : ""}>
                      {event.event_type}
                    </span>{" "}
                    {event.message ? <span>{event.message}</span> : null}
                  </summary>
                  <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-[11px]">
                    {JSON.stringify(event.data, null, 2)}
                  </pre>
                </details>
              ))
            ) : (
              <p className="p-3 text-xs text-muted-foreground">No events recorded.</p>
            )}
          </div>
        </section>
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
            Raw run payload
          </summary>
          <pre className="max-h-80 overflow-auto border-t border-border bg-muted p-3 text-xs">
            {JSON.stringify(run, null, 2)}
          </pre>
        </details>
      </div>
    </Modal>
  );
}

function RunDiffPanel({
  diff,
  loading,
  error,
  onRefresh,
}: {
  diff: WorkspaceDiff | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <section className="grid min-h-[38rem] overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="grid min-w-0 gap-1">
          <div className="flex min-w-0 items-center gap-2 text-xs font-semibold">
            <GitCompareIcon className="size-3.5" />
            Workspace diff
            {diff?.available ? (
              <span className="font-mono text-[10px] text-muted-foreground">
                {diff.files.length} changed · {diff.all_files.length} total
              </span>
            ) : null}
          </div>
          {diff?.workspace_path ? (
            <p className="truncate font-mono text-[10px] text-muted-foreground">
              {diff.workspace_path}
            </p>
          ) : null}
        </div>
        <Button size="sm" variant="ghost" disabled={loading} onClick={onRefresh}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>
      {error ? (
        <p className="p-3 text-xs text-destructive">{error}</p>
      ) : !diff ? (
        <p className="p-3 text-xs text-muted-foreground">
          {loading ? "Loading diff..." : "No diff loaded."}
        </p>
      ) : !diff.available ? (
        <p className="p-3 text-xs text-muted-foreground">{diff.error ?? "No diff available."}</p>
      ) : (
        <PatchDiffViewer
          patch={diff.patch}
          cacheScope={`orchestration-run:${diff.workspace_path ?? "workspace"}`}
          cwd={diff.workspace_path}
          emptyLabel="No tracked patch."
          className="min-h-0 flex-1 rounded-none border-0"
        />
      )}
    </section>
  );
}

function LogDialog({ log, onClose }: { log: LogRecord; onClose: () => void }) {
  return (
    <Modal title={`${log.level} · ${log.event}`} onClose={onClose} wide>
      <pre className="max-h-[70vh] overflow-auto rounded-lg bg-muted p-3 text-xs">
        {JSON.stringify(log, null, 2)}
      </pre>
    </Modal>
  );
}

function PlannerDialog({
  session,
  input,
  busy,
  error,
  onInput,
  onSend,
  onCreate,
  onRestart,
  onClose,
}: {
  session: PlannerSession | null;
  input: string;
  busy: boolean;
  error: string | null;
  onInput: (value: string) => void;
  onSend: () => void;
  onCreate: () => void;
  onRestart: () => void;
  onClose: () => void;
}) {
  const draft = session?.draft;
  const missing = plannerMissingFields(draft);
  return (
    <Modal title="Planning agent" onClose={onClose} wide>
      <div className="grid max-h-[78vh] min-h-[620px] grid-rows-[minmax(0,1fr)_auto] gap-3">
        <div className="grid min-h-0 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="min-h-0 overflow-auto rounded-lg border border-border bg-background p-3">
            <div className="space-y-2">
              {session?.messages.map((message) => (
                <PlannerBubble key={message.id} message={message} />
              ))}
              {!session && !error ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                  Starting planning session...
                </p>
              ) : null}
              {busy ? (
                <p className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
                  Planner is thinking...
                </p>
              ) : null}
              {error ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  <p>{error}</p>
                  <Button className="mt-2" size="sm" variant="outline" onClick={onRestart}>
                    Retry
                  </Button>
                </div>
              ) : null}
            </div>
          </section>

          <TicketDraftPreview draft={draft} missing={missing} />
        </div>

        <form
          className="grid gap-2 border-t border-border pt-3 lg:grid-cols-[minmax(0,1fr)_90px_120px]"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <textarea
            className="form-input min-h-16 py-2"
            value={input}
            disabled={!session || busy}
            placeholder="Chat with the planner. It will update the draft as details become clear."
            onChange={(event) => onInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          <Button className="h-full min-h-9" disabled={!session || busy || !input.trim()}>
            <SendIcon className="size-3.5" />
            Send
          </Button>
          <Button
            className="h-full min-h-9"
            type="button"
            variant="secondary"
            disabled={!draft?.ready || busy}
            onClick={onCreate}
          >
            <PlusIcon className="size-3.5" />
            Create card
          </Button>
        </form>
      </div>
    </Modal>
  );
}

function PlannerBubble({ message }: { message: PlannerMessage }) {
  const isUser = message.role === "user";
  return (
    <article className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[82%] rounded-lg border px-3 py-2",
          isUser ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card",
        )}
      >
        <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase opacity-70">
          <span>{isUser ? "you" : "planner-agent"}</span>
          <span>{new Date(message.created_at).toLocaleTimeString()}</span>
        </div>
        <p className="whitespace-pre-wrap text-xs leading-relaxed">{message.body}</p>
      </div>
    </article>
  );
}

function TicketDraftPreview({
  draft,
  missing,
}: {
  draft: PlannerDraft | undefined;
  missing: string[];
}) {
  return (
    <aside className="min-h-0 overflow-auto rounded-lg border border-border bg-card p-3 text-xs">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Draft card</h3>
        <span
          className={cn(
            "rounded px-2 py-1 font-mono text-[10px]",
            missing.length
              ? "bg-amber-500/10 text-amber-400"
              : "bg-emerald-500/10 text-emerald-400",
          )}
        >
          {missing.length ? `${missing.length} missing` : "ready"}
        </span>
      </div>
      <div className="space-y-3">
        <DraftField label="Title" value={draft?.title} />
        <DraftField label="Goal" value={draft?.goal} multiline />
        <DraftList label="Acceptance" values={draft?.acceptance_criteria} />
        <DraftList label="Constraints" values={draft?.constraints} />
        <DraftList label="Notes" values={draft?.notes} />
        <div className="grid grid-cols-2 gap-2">
          <DraftField label="Priority" value={draft?.priority ? `P${draft.priority}` : ""} />
          <DraftField label="State" value={draft?.state} />
        </div>
        <DraftList label="Labels" values={draft?.labels} inline />
      </div>
    </aside>
  );
}

function DraftField({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string | undefined;
  multiline?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase text-muted-foreground">{label}</div>
      <div
        className={cn(
          "rounded border border-border bg-background px-2 py-1.5",
          multiline ? "min-h-16 whitespace-pre-wrap" : "truncate",
          !value && "text-muted-foreground",
        )}
      >
        {value || "Not set"}
      </div>
    </div>
  );
}

function DraftList({
  label,
  values,
  inline,
}: {
  label: string;
  values: string[] | undefined;
  inline?: boolean;
}) {
  const items = values ?? [];
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase text-muted-foreground">{label}</div>
      {items.length ? (
        <div className={cn(inline ? "flex flex-wrap gap-1" : "space-y-1")}>
          {items.map((value) => (
            <div key={value} className="rounded border border-border bg-background px-2 py-1.5">
              {value}
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded border border-border bg-background px-2 py-1.5 text-muted-foreground">
          Not set
        </div>
      )}
    </div>
  );
}

function plannerMissingFields(draft: PlannerDraft | undefined) {
  if (!draft) return ["title", "goal", "acceptance"];
  return [
    !draft.title ? "title" : null,
    !draft.goal ? "goal" : null,
    !draft.acceptance_criteria.length ? "acceptance" : null,
  ].filter((value): value is string => Boolean(value));
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4 backdrop-blur-sm">
      <section
        className={cn(
          "w-full rounded-xl border border-border bg-popover shadow-xl",
          wide ? "max-w-7xl" : "max-w-xl",
        )}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose}>
            ×
          </Button>
        </header>
        <div className="p-4">{children}</div>
      </section>
    </div>
  );
}

function ModalFooter({
  onClose,
  onSave,
  disabled,
}: {
  onClose: () => void;
  onSave: () => void;
  disabled: boolean;
}) {
  return (
    <footer className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
      <Button variant="ghost" size="sm" onClick={onClose}>
        Cancel
      </Button>
      <Button size="sm" disabled={disabled} onClick={onSave}>
        Save
      </Button>
    </footer>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium">
      {label}
      {children}
    </label>
  );
}

function cardBelongsToProject(card: Card, runs: AgentRun[], project: T3Project) {
  const projectRoot = normalizePath(project.workspaceRoot);
  const projectLeaf = projectRoot.split("/").toReversed().find(Boolean) ?? "";
  if (projectLeaf === card.identifier.toLowerCase()) return true;
  if (project.title.toLowerCase().startsWith(card.identifier.toLowerCase())) return true;
  return runs.some((run) => {
    if (run.issue_id !== card.id || !run.workspace_path) return false;
    const workspacePath = normalizePath(run.workspace_path);
    return workspacePath === projectRoot || workspacePath.startsWith(`${projectRoot}/`);
  });
}

function findRouteProject(projects: T3Project[], search: OrchestrationSearch) {
  const projectId = search.projectId?.trim();
  const projectRoot = search.workspaceRoot?.trim();
  if (projectId) {
    const byId = projects.find((project) => project.id === projectId);
    if (byId) return byId;
  }
  if (!projectRoot) return null;
  const normalizedRoot = normalizePath(projectRoot);
  return (
    projects.find((project) => normalizePath(project.workspaceRoot) === normalizedRoot) ?? null
  );
}

function projectFromRouteSearch(search: OrchestrationSearch): T3Project | null {
  const workspaceRoot = search.workspaceRoot?.trim();
  if (!workspaceRoot) return null;
  const title = search.title?.trim() || workspaceRoot.split("/").toReversed().find(Boolean);
  return {
    id: search.projectId?.trim() || `route:${normalizePath(workspaceRoot)}`,
    title: title || "T3 project",
    workspaceRoot,
  };
}

function normalizePath(value: string) {
  return value.replace(/\/+$/, "").toLowerCase();
}

function logRecordKey(log: LogRecord) {
  return [
    log.ts,
    log.level,
    log.event,
    log.agent_id ?? "",
    log.identifier ?? "",
    log.message ?? "",
    log.error ?? "",
  ].join("|");
}

async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${ORCHESTRATOR_API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const rawPayload = await response.text();
  const payload = rawPayload
    ? (safeParseJson(rawPayload, response.status, path) as T | { error?: string })
    : undefined;
  if (!response.ok) {
    throw new Error(
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : `HTTP ${response.status}`,
    );
  }
  return payload as T;
}

function safeParseJson(source: string, status: number, path: string) {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`Invalid JSON from ${path} (${status}): ${source.slice(0, 120) || "empty"}`);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
