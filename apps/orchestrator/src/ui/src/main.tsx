import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PatchDiff } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import "./styles.css";

type Card = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  labels: string[];
  comments: CardComment[];
  comment_count: number;
  extra_data: Record<string, unknown>;
};

type CardComment = {
  id: string;
  issue_id: string;
  author: string;
  body: string;
  kind: "comment" | "planning" | "agent" | "result";
  created_at: string;
};

type RunningAgent = {
  run_id: string;
  agent_id: string;
  issue: Card;
  status: string;
  attempt: number | null;
  workspace_path: string;
  prompt_preview: string | null;
  command: string;
  model: string | null;
  profile: string | null;
  pid: number | null;
  started_at?: string;
  elapsed_ms: number;
  last_codex_event: string | null;
  last_codex_message: string | null;
  turn_count: number;
  tokens: { input: number; output: number; total: number };
};

type Retry = {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at: string;
  error: string | null;
};

type Status = {
  running: RunningAgent[];
  claimed: string[];
  retries: Retry[];
  completed: string[];
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    runtime_ms: number;
  };
  config: {
    active_states: string[];
    terminal_states: string[];
    max_concurrent_agents: number;
  } | null;
};

type AgentRunEvent = {
  id: string;
  run_id: string;
  issue_id: string;
  agent_id: string;
  level: "debug" | "info" | "warn" | "error";
  event_type: string;
  message: string | null;
  data: Record<string, unknown>;
  created_at: string;
};

type RealtimePlannerEventMessage = {
  type: "planner.event";
  sessionId: string;
  event: Record<string, unknown>;
};

type RealtimePlannerDoneMessage = {
  type: "planner.done";
  sessionId: string;
  session: PlannerSession;
};

type RealtimeRunEventMessage = {
  type: "run.event";
  runId: string;
  issueId: string;
  agentId: string;
  eventType: string;
  event: AgentRunEvent;
};

type AgentRun = {
  id: string;
  issue_id: string;
  identifier: string;
  agent_id: string;
  status: string;
  attempt: number | null;
  command: string;
  model: string | null;
  profile: string | null;
  workspace_path: string | null;
  workspace_exists: boolean;
  pid: number | null;
  summary: string | null;
  error: string | null;
  moved_to_state: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  runtime_ms: number;
  started_at: string;
  finished_at: string | null;
  events: AgentRunEvent[];
  t3_thread_id?: string | null;
  t3_chat_url?: string | null;
  t3_embed_url?: string | null;
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

type LogRecord = {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  agent_id?: string;
  identifier?: string;
  issue_id?: string;
  title?: string;
  message?: string | null;
  error?: string | null;
  command?: string;
  workspace_path?: string;
  codex_event_type?: string;
  data?: Record<string, unknown>;
};

type CardDraft = {
  id?: string;
  identifier?: string;
  title: string;
  description: string;
  state: string;
  priority: string;
  labels: string;
  extraData: string;
  comments: CardComment[];
  newComment: string;
  newCommentKind: CardComment["kind"];
  runs: AgentRun[];
  t3Links: CardT3Links | null;
};

type CardT3Links = {
  threadId: string;
  chatUrl: string;
  embedUrl: string;
};

type Filters = { search: string; level: string; event: string; agent: string };

type ActivityTab = "agents" | "worktrees" | "retries" | "log" | "runs";
type ThemePreference = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

type WorktreeGroup = {
  path: string;
  workspaceKey: string | null;
  assignedCards: Card[];
  runningAgents: RunningAgent[];
  runs: AgentRun[];
  latestRun: AgentRun | null;
};

type WorktreeSelection = {
  kind: "worktree" | "files" | "ticket" | "agent";
  worktreePath: string;
  cardId?: string;
  agentId?: string;
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

type WorkflowDocument = {
  path: string;
  source: string;
  updatedAt: string;
  loadedAt: string;
};

const emptyDraft: CardDraft = {
  title: "",
  description: "",
  state: "Todo",
  priority: "",
  labels: "",
  extraData: "{}",
  comments: [],
  newComment: "",
  newCommentKind: "planning",
  runs: [],
  t3Links: null,
};
const emptyFilters: Filters = { search: "", level: "", event: "", agent: "" };
const THEME_STORAGE_KEY = "t3code:theme";
const THEME_CHANGE_EVENT = "t3code:theme-change";
const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function getStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(stored) ? stored : "system";
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveThemePreference(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? getSystemTheme() : preference;
}

function applyThemePreference(preference: ThemePreference) {
  const resolvedTheme = resolveThemePreference(preference);
  document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  document.documentElement.style.backgroundColor = resolvedTheme === "dark" ? "#06080d" : "#ffffff";
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])')
    ?.setAttribute("content", resolvedTheme === "dark" ? "#06080d" : "#ffffff");
}

function useThemePreference() {
  const [theme, setThemeState] = useState<ThemePreference>(() => getStoredThemePreference());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    applyThemePreference(theme);
  }, [theme, systemTheme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncFromStorage = () => setThemeState(getStoredThemePreference());
    const syncSystemTheme = () => setSystemTheme(getSystemTheme());
    media.addEventListener("change", syncSystemTheme);
    window.addEventListener("storage", syncFromStorage);
    window.addEventListener(THEME_CHANGE_EVENT, syncFromStorage);
    return () => {
      media.removeEventListener("change", syncSystemTheme);
      window.removeEventListener("storage", syncFromStorage);
      window.removeEventListener(THEME_CHANGE_EVENT, syncFromStorage);
    };
  }, []);

  function setTheme(nextTheme: ThemePreference) {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    setThemeState(nextTheme);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }

  return { theme, resolvedTheme, setTheme };
}

function App() {
  const { theme, resolvedTheme, setTheme } = useThemePreference();
  const embedded = new URLSearchParams(window.location.search).get("embedded") === "t3";
  const [cards, setCards] = useState<Card[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [draft, setDraft] = useState<CardDraft | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [logsPaused, setLogsPaused] = useState(false);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [showNoiseLogs, setShowNoiseLogs] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [boardSearch, setBoardSearch] = useState("");
  const [activityTab, setActivityTab] = useState<ActivityTab>("log");
  const [activityCollapsed, setActivityCollapsed] = useState(false);
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [planner, setPlanner] = useState<PlannerSession | null>(null);
  const [plannerInput, setPlannerInput] = useState("");
  const [plannerBusy, setPlannerBusy] = useState(false);
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const [workflowOpen, setWorkflowOpen] = useState(false);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [logsPaused]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    let refreshTimer: number | null = null;
    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string };
        if (payload.type === "run.event") {
          applyRealtimeRunEvent(payload as RealtimeRunEventMessage);
          if (refreshTimer) window.clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => void refresh(), 1000);
        } else if (payload.type === "planner.event") {
          applyRealtimePlannerEvent(payload as RealtimePlannerEventMessage);
        } else if (payload.type === "planner.done") {
          const done = payload as RealtimePlannerDoneMessage;
          setPlanner((current) => (current?.id === done.sessionId ? done.session : current));
          setPlannerBusy(false);
        }
      } catch {
        // Ignore malformed realtime payloads; polling remains the fallback.
      }
    });
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      socket.close();
    };
  }, [logsPaused]);

  useEffect(() => {
    function handler(event: KeyboardEvent) {
      const isInput = ["INPUT", "TEXTAREA", "SELECT"].includes(
        document.activeElement?.tagName ?? "",
      );
      if (event.key === "Escape" && draft) {
        setDraft(null);
        return;
      }
      if (isInput) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("[data-board-search]")?.focus();
      }
      if (event.key === "/" && !draft) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("[data-board-search]")?.focus();
      }
      if (event.key.toLowerCase() === "n" && !draft && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setDraft(emptyDraft);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [draft]);

  function applyRealtimePlannerEvent(payload: RealtimePlannerEventMessage) {
    setPlanner((current) => {
      if (!current || current.id !== payload.sessionId) return current;
      const text = typeof payload.event.text === "string" ? payload.event.text : "";
      if (!text) return current;
      const messages = [...current.messages];
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && last.body.startsWith("…")) {
        messages[messages.length - 1] = { ...last, body: `${last.body}${text}` };
      } else {
        messages.push({
          id: `stream-${payload.sessionId}`,
          role: "assistant",
          body: `…${text}`,
          created_at: new Date().toISOString(),
        });
      }
      return { ...current, messages };
    });
  }

  function applyRealtimeRunEvent(payload: RealtimeRunEventMessage) {
    setRuns((current) => {
      let found = false;
      const next = current.map((run) => {
        if (run.id !== payload.runId) return run;
        found = true;
        if (run.events.some((event) => event.id === payload.event.id)) return run;
        const events = [...run.events, payload.event].toSorted((left, right) =>
          left.created_at.localeCompare(right.created_at),
        );
        return {
          ...run,
          events,
          summary:
            payload.event.event_type === "run_succeeded" ? payload.event.message : run.summary,
          error: payload.event.level === "error" ? payload.event.message : run.error,
        };
      });
      return found ? next : current;
    });
    if (!logsPaused) {
      setLogs((current) => [
        ...current.slice(-299),
        {
          ts: payload.event.created_at,
          level: payload.event.level,
          event: payload.event.event_type,
          agent_id: payload.event.agent_id,
          message: payload.event.message ?? undefined,
          data: payload.event.data,
        },
      ]);
    }
    setStatus((current) => {
      if (!current) return current;
      return {
        ...current,
        running: current.running.map((agent) =>
          agent.run_id === payload.runId
            ? {
                ...agent,
                last_codex_event: payload.event.event_type,
                last_codex_message: payload.event.message ?? agent.last_codex_message,
              }
            : agent,
        ),
      };
    });
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const [cardsResponse, statusResponse, runsResponse] = await Promise.all([
        fetch("/api/cards"),
        fetch("/api/orchestrator/status"),
        fetch("/api/orchestrator/runs?limit=50"),
      ]);
      const cardsPayload = (await cardsResponse.json()) as { cards: Card[]; columns: string[] };
      setCards(cardsPayload.cards);
      setColumns(cardsPayload.columns);
      setStatus((await statusResponse.json()) as Status);
      setRuns(((await runsResponse.json()) as { runs: AgentRun[] }).runs);
      if (!logsPaused) {
        const logsResponse = await fetch("/api/orchestrator/logs?limit=300");
        setLogs(((await logsResponse.json()) as { logs: LogRecord[] }).logs);
      }
      setLastFetchedAt(Date.now());
      setError(null);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setRefreshing(false);
    }
  }

  async function saveCard(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const payload = {
      title: draft.title,
      description: draft.description,
      state: draft.state,
      priority: draft.priority ? Number(draft.priority) : null,
      labels: draft.labels,
      extra_data: parseExtraDataDraft(draft.extraData),
    };
    await fetch(draft.id ? `/api/cards/${draft.id}` : "/api/cards", {
      method: draft.id ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setDraft(null);
    await refresh();
  }

  async function addCardComment() {
    if (!draft?.id || !draft.newComment.trim()) return;
    const response = await fetch(`/api/cards/${draft.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        author: "user",
        kind: draft.newCommentKind,
        body: draft.newComment,
      }),
    });
    if (!response.ok) return;
    const comment = (await response.json()) as CardComment;
    setDraft({ ...draft, comments: [...draft.comments, comment], newComment: "" });
    await refresh();
  }

  async function moveCard(id: string, state: string) {
    await fetch(`/api/cards/${id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
    });
    await refresh();
  }

  async function openPlanner() {
    setPlannerOpen(true);
    setPlannerError(null);
    if (planner) return;
    await startPlannerSession();
  }

  async function startPlannerSession() {
    setPlannerBusy(true);
    try {
      setPlanner(await apiJson<PlannerSession>("/api/planner/sessions", { method: "POST" }));
    } catch (caught) {
      setPlannerError(errorMessage(caught));
    } finally {
      setPlannerBusy(false);
    }
  }

  async function sendPlannerMessage(event?: React.FormEvent) {
    event?.preventDefault();
    if (!planner || !plannerInput.trim()) return;
    const message = plannerInput.trim();
    setPlannerInput("");
    setPlannerBusy(true);
    setPlannerError(null);
    try {
      setPlanner(
        await apiJson<PlannerSession>(`/api/planner/sessions/${planner.id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
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

  async function createPlannerCard() {
    if (!planner?.draft.ready) return;
    setPlannerBusy(true);
    setPlannerError(null);
    try {
      await apiJson<{ card: Card }>(`/api/planner/sessions/${planner.id}/card`, { method: "POST" });
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

  const levelOptions = useMemo(() => unique(logs.map((log) => log.level)), [logs]);
  const eventOptions = useMemo(() => unique(logs.map((log) => log.event)), [logs]);
  const agentOptions = useMemo(
    () => unique(logs.map((log) => log.agent_id).filter(Boolean) as string[]),
    [logs],
  );
  const signalLogs = useMemo(() => logs.filter(isSignalLog), [logs]);
  const visibleLogSource = showNoiseLogs ? logs : signalLogs;
  const filteredLogs = useMemo(
    () => visibleLogSource.filter((log) => matchesLog(log, filters)),
    [visibleLogSource, filters],
  );
  const filtersActive = filters.search || filters.level || filters.event || filters.agent;
  const errorCount = useMemo(() => logs.filter((log) => log.level === "error").length, [logs]);
  const worktrees = useMemo(
    () => buildWorktreeGroups(cards, status?.running ?? [], runs),
    [cards, status?.running, runs],
  );
  const filteredCards = useMemo(() => {
    if (!boardSearch.trim()) return cards;
    const q = boardSearch.toLowerCase();
    return cards.filter((card) =>
      [card.identifier, card.title, card.description, card.labels.join(" ")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [cards, boardSearch]);

  return (
    <div className="min-h-screen bg-bg text-ink" data-color-mode={resolvedTheme}>
      {embedded ? null : (
        <Header
          theme={theme}
          setTheme={setTheme}
          lastFetchedAt={lastFetchedAt}
          refreshing={refreshing}
          error={error}
          boardSearch={boardSearch}
          setBoardSearch={setBoardSearch}
          onRefresh={() => void refresh()}
          onNew={() => setDraft(emptyDraft)}
          onPlan={() => void openPlanner()}
          onWorkflow={() => setWorkflowOpen(true)}
        />
      )}

      <div className={embedded ? "min-h-screen" : "min-h-[calc(100vh-3.5rem)]"}>
        <div className="min-w-0">
          <StatusStrip status={status} embedded={embedded} />

          <main className={embedded ? "px-4 pt-4 pb-8 md:px-5" : "px-5 pt-5 pb-10 md:px-7"}>
            <BoardSection
              columns={columns}
              cards={filteredCards}
              runs={runs}
              totalCards={cards.length}
              dragOverColumn={dragOverColumn}
              onDragOverColumn={(c) => setDragOverColumn(c)}
              onDrop={(column) => {
                if (draggedId) void moveCard(draggedId, column);
                setDraggedId(null);
                setDragOverColumn(null);
              }}
              onCardDragStart={(card) => setDraggedId(card.id)}
              onCardEdit={(card) =>
                setDraft(
                  draftFromCard(
                    card,
                    runs.filter((run) => run.issue_id === card.id),
                  ),
                )
              }
              onNew={() => setDraft(emptyDraft)}
              searching={Boolean(boardSearch.trim())}
            />

            <ActivityPanel
              tab={activityTab}
              setTab={setActivityTab}
              collapsed={activityCollapsed}
              setCollapsed={setActivityCollapsed}
              status={status}
              worktrees={worktrees}
              runs={runs}
              logs={logs}
              filteredLogs={filteredLogs}
              filters={filters}
              setFilters={setFilters}
              showNoiseLogs={showNoiseLogs}
              setShowNoiseLogs={setShowNoiseLogs}
              logsPaused={logsPaused}
              setLogsPaused={setLogsPaused}
              errorCount={errorCount}
              filtersActive={Boolean(filtersActive)}
              levelOptions={levelOptions}
              eventOptions={eventOptions}
              agentOptions={agentOptions}
              fetchedAt={lastFetchedAt}
            />
          </main>
        </div>
      </div>

      {plannerOpen ? (
        <PlannerPanel
          session={planner}
          input={plannerInput}
          busy={plannerBusy}
          error={plannerError}
          setInput={setPlannerInput}
          onSubmit={sendPlannerMessage}
          onCreate={() => void createPlannerCard()}
          onClose={() => setPlannerOpen(false)}
          onRestart={() => {
            setPlanner(null);
            setPlannerInput("");
            setPlannerError(null);
            void startPlannerSession();
          }}
        />
      ) : null}
      {workflowOpen ? <WorkflowEditorPanel onClose={() => setWorkflowOpen(false)} /> : null}
      {draft ? (
        <CardDialog
          draft={draft}
          columns={columns}
          setDraft={setDraft}
          onSubmit={saveCard}
          onAddComment={addCardComment}
        />
      ) : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Header                                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

function Header({
  theme,
  setTheme,
  lastFetchedAt,
  refreshing,
  error,
  boardSearch,
  setBoardSearch,
  onRefresh,
  onNew,
  onPlan,
  onWorkflow,
}: {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  lastFetchedAt: number | null;
  refreshing: boolean;
  error: string | null;
  boardSearch: string;
  setBoardSearch: (value: string) => void;
  onRefresh: () => void;
  onNew: () => void;
  onPlan: () => void;
  onWorkflow: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-bg/85 px-5 backdrop-blur-md md:px-7">
      <div className="flex items-center gap-2.5">
        <div className="grid h-7 w-7 place-items-center rounded-md bg-ink text-[11px] font-semibold text-bg shadow-[inset_0_1px_0_0_rgb(255_255_255_/_0.08)]">
          KS
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[14px] font-semibold tracking-tight">Kanban Symphony</span>
          <span className="hidden text-[12px] text-mute-2 sm:inline">·</span>
          <span className="hidden text-[12px] text-mute md:inline">orchestration</span>
        </div>
      </div>

      <div className="ml-3 hidden max-w-md flex-1 md:flex">
        <div className="relative w-full">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mute-2">
            <SearchIcon />
          </span>
          <input
            data-board-search
            value={boardSearch}
            onChange={(e) => setBoardSearch(e.target.value)}
            placeholder="Search cards by title, label, identifier…"
            className="input h-8 pl-8 pr-16 text-[12.5px]"
          />
          <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
            <kbd>⌘</kbd>
            <kbd>K</kbd>
          </span>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ConnectionState lastFetchedAt={lastFetchedAt} refreshing={refreshing} error={error} />
        <label className="sr-only" htmlFor="theme-preference">
          Theme
        </label>
        <select
          id="theme-preference"
          className="input h-8 w-[96px] text-[12px]"
          value={theme}
          onChange={(event) => {
            if (isThemePreference(event.target.value)) setTheme(event.target.value);
          }}
          title="Theme"
        >
          {THEME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button className="icon-btn" onClick={onRefresh} disabled={refreshing} title="Refresh">
          <span className={refreshing ? "inline-block animate-spin" : "inline-block"} aria-hidden>
            <RefreshIcon />
          </span>
        </button>
        <button className="btn-ghost hidden sm:inline-flex" onClick={onPlan}>
          <ChatIcon />
          <span>Plan ticket</span>
        </button>
        <button className="btn-ghost hidden sm:inline-flex" onClick={onWorkflow}>
          <DocIcon />
          <span>Workflow</span>
        </button>
        <button className="btn-primary" onClick={onNew}>
          <span className="text-[14px] leading-none">+</span>
          <span>New card</span>
          <kbd className="ml-1 hidden border-ink-3 bg-ink-2 text-mute-3 sm:inline-flex">N</kbd>
        </button>
      </div>
    </header>
  );
}

function ConnectionState({
  lastFetchedAt,
  refreshing,
  error,
}: {
  lastFetchedAt: number | null;
  refreshing: boolean;
  error: string | null;
}) {
  const age = useNow(lastFetchedAt);
  if (error) {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-err" title={error}>
        <span className="h-1.5 w-1.5 rounded-full bg-err" />
        Connection error
      </span>
    );
  }
  if (refreshing && !lastFetchedAt) {
    return <span className="text-[11.5px] font-medium text-mute">Connecting…</span>;
  }
  return (
    <span className="hidden items-center gap-1.5 text-[11.5px] font-medium text-mute sm:flex">
      <span className="pulse-dot relative h-1.5 w-1.5 rounded-full bg-ok text-ok" />
      <span className="text-ink-2">Live</span>
      <span className="text-mute-2">·</span>
      <span>{age}</span>
    </span>
  );
}

function useNow(reference: number | null): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!reference) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - reference) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

function useLiveElapsed(elapsedMs: number, fetchedAt: number | null): number {
  const baselineRef = useRef({ elapsedMs, fetchedAt: fetchedAt ?? Date.now() });
  const [, setTick] = useState(0);
  useEffect(() => {
    baselineRef.current = { elapsedMs, fetchedAt: fetchedAt ?? Date.now() };
  }, [elapsedMs, fetchedAt]);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return baselineRef.current.elapsedMs + (Date.now() - baselineRef.current.fetchedAt);
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Status Strip                                                            */
/* ──────────────────────────────────────────────────────────────────────── */

function StatusStrip({ status, embedded = false }: { status: Status | null; embedded?: boolean }) {
  const max = status?.config?.max_concurrent_agents ?? 0;
  const running = status?.running.length ?? 0;
  const capacityPct = max ? Math.min(100, Math.round((running / max) * 100)) : 0;

  return (
    <div
      className={`sticky ${embedded ? "top-0" : "top-14"} z-20 flex h-11 items-center gap-5 overflow-x-auto border-b border-border bg-surface/85 px-5 backdrop-blur-md md:px-7 no-scrollbar`}
    >
      <Stat
        label="Running"
        value={
          <span>
            <span className="text-ink">{running}</span>
            <span className="text-mute-2">/{max || "—"}</span>
          </span>
        }
        tail={
          max ? (
            <div className="ml-2 hidden items-center gap-1.5 sm:flex">
              <div className="skeleton-bar w-20">
                <span style={{ width: `${capacityPct}%` }} />
              </div>
              <span className="font-mono text-[10.5px] tabular-nums text-mute-2">
                {capacityPct}%
              </span>
            </div>
          ) : null
        }
      />
      <Divider />
      <Stat
        label="Queued"
        value={
          <span className={(status?.retries.length ?? 0) > 0 ? "text-warn" : "text-ink"}>
            {status?.retries.length ?? 0}
          </span>
        }
      />
      <Divider />
      <Stat
        label="Done"
        value={<span className="text-ink">{status?.completed.length ?? 0}</span>}
      />
      <Divider />
      <Stat
        label="Claimed"
        value={<span className="text-ink">{status?.claimed.length ?? 0}</span>}
      />
      <Divider />
      <Stat
        label="Tokens"
        value={
          <span className="text-ink">{formatNumber(status?.codex_totals.total_tokens ?? 0)}</span>
        }
        tail={
          status ? (
            <span className="ml-1.5 hidden font-mono text-[10.5px] tabular-nums text-mute-2 lg:inline">
              {formatNumber(status.codex_totals.input_tokens)} in /{" "}
              {formatNumber(status.codex_totals.output_tokens)} out
            </span>
          ) : null
        }
      />
      <Divider />
      <Stat
        label="Runtime"
        value={
          <span className="text-ink">{formatDuration(status?.codex_totals.runtime_ms ?? 0)}</span>
        }
      />
      {status?.config?.active_states ? (
        <span className="ml-auto hidden items-center gap-1.5 whitespace-nowrap text-[11.5px] text-mute lg:flex">
          <span className="text-mute-2">Active</span>
          <code className="rounded bg-bg-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">
            {status.config.active_states.join(", ")}
          </code>
        </span>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tail,
}: {
  label: string;
  value: React.ReactNode;
  tail?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium tabular-nums">
      <span className="text-mute-2">{label}</span>
      <span className="font-semibold">{value}</span>
      {tail}
    </div>
  );
}

function Divider() {
  return <span className="hidden h-3 w-px bg-border-2 sm:block" />;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Board                                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

function BoardSection({
  columns,
  cards,
  runs,
  totalCards,
  dragOverColumn,
  onDragOverColumn,
  onDrop,
  onCardDragStart,
  onCardEdit,
  onNew,
  searching,
}: {
  columns: string[];
  cards: Card[];
  runs: AgentRun[];
  totalCards: number;
  dragOverColumn: string | null;
  onDragOverColumn: (column: string | null) => void;
  onDrop: (column: string) => void;
  onCardDragStart: (card: Card) => void;
  onCardEdit: (card: Card) => void;
  onNew: () => void;
  searching: boolean;
}) {
  return (
    <section className="reveal">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[15px] font-semibold tracking-tight">Board</h2>
          <span className="font-mono text-[11px] tabular-nums text-mute-2">
            {searching ? `${cards.length}/${totalCards}` : totalCards} cards
          </span>
        </div>
        <p className="hidden text-[11.5px] text-mute md:block">
          drag to move · double-click to edit · <kbd>N</kbd> to add
        </p>
      </div>

      <div className="grid auto-cols-[minmax(280px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2 lg:auto-cols-fr">
        {columns.map((column) => {
          const columnCards = cards.filter((card) => card.state === column);
          const isOver = dragOverColumn === column;
          return (
            <KanbanColumn
              key={column}
              column={column}
              cards={columnCards}
              runs={runs}
              isOver={isOver}
              onDragOver={(event) => {
                event.preventDefault();
                if (dragOverColumn !== column) onDragOverColumn(column);
              }}
              onDragLeave={() => {
                if (dragOverColumn === column) onDragOverColumn(null);
              }}
              onDrop={() => onDrop(column)}
              onCardDragStart={onCardDragStart}
              onCardEdit={onCardEdit}
              onAddCard={onNew}
            />
          );
        })}
      </div>
    </section>
  );
}

function KanbanColumn({
  column,
  cards,
  runs,
  isOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onCardDragStart,
  onCardEdit,
  onAddCard,
}: {
  column: string;
  cards: Card[];
  runs: AgentRun[];
  isOver: boolean;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: () => void;
  onCardDragStart: (card: Card) => void;
  onCardEdit: (card: Card) => void;
  onAddCard: () => void;
}) {
  const tone = columnTone(column);
  return (
    <section
      className={`lane flex min-h-[280px] flex-col p-2 ${isOver ? "is-over" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="mb-2 flex items-center justify-between gap-2 px-1.5 pt-1">
        <div className="flex items-center gap-2">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: tone }}
            aria-hidden
          />
          <h3 className="text-[12.5px] font-semibold tracking-tight">{column}</h3>
          <span className="font-mono text-[10.5px] tabular-nums text-mute-2">{cards.length}</span>
        </div>
        <button
          onClick={onAddCard}
          className="icon-btn h-6 w-6 text-[12px]"
          title={`Add to ${column}`}
        >
          +
        </button>
      </header>
      <div className="flex flex-1 flex-col gap-2">
        {cards.map((card) => (
          <CardTile
            key={card.id}
            card={card}
            t3Links={latestT3LinksForRuns(runs.filter((run) => run.issue_id === card.id))}
            onDragStart={() => onCardDragStart(card)}
            onEdit={() => onCardEdit(card)}
          />
        ))}
        {cards.length === 0 ? (
          <button
            type="button"
            onClick={onAddCard}
            className="flex h-16 items-center justify-center rounded-lg border border-dashed border-border-2 text-[11.5px] text-mute-2 transition hover:border-mute-2 hover:text-mute hover:bg-surface/50"
          >
            + Add a card
          </button>
        ) : null}
      </div>
    </section>
  );
}

function columnTone(column: string): string {
  const lower = column.toLowerCase();
  if (lower.includes("done") || lower.includes("complete")) return "var(--color-ok)";
  if (lower.includes("review")) return "var(--color-data)";
  if (lower.includes("progress") || lower.includes("doing")) return "var(--color-info)";
  if (lower.includes("block") || lower.includes("fail")) return "var(--color-err)";
  return "var(--color-mute-2)";
}

function CardTile({
  card,
  t3Links,
  onDragStart,
  onEdit,
}: {
  card: Card;
  t3Links: CardT3Links | null;
  onDragStart: () => void;
  onEdit: () => void;
}) {
  return (
    <article
      draggable
      onDragStart={onDragStart}
      onDoubleClick={onEdit}
      className="card-tile group relative flex flex-col gap-2 px-3 py-2.5"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[10.5px] font-medium uppercase tracking-wider text-mute-2">
          {card.identifier}
        </span>
        <div className="flex items-center gap-1.5">
          {t3Links ? (
            <a
              href={t3Links.chatUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-data/20 bg-data-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold text-data transition hover:border-data/35 hover:bg-data-soft/80"
              title="Open T3 chat"
              aria-label={`Open T3 chat for ${card.identifier}`}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              T3
            </a>
          ) : null}
          <PriorityChip priority={card.priority} />
        </div>
      </div>
      <h4 className="text-[13.5px] font-medium leading-snug tracking-tight text-ink">
        {card.title}
      </h4>
      {card.description ? (
        <p className="line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed text-mute">
          {card.description}
        </p>
      ) : null}
      {(card.labels.length > 0 ||
        card.comment_count > 0 ||
        Object.keys(card.extra_data ?? {}).length > 0) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {card.labels.map((label) => (
            <span
              key={label}
              className="rounded-md bg-bg-2 px-1.5 py-0.5 text-[10px] font-medium text-mute"
            >
              {label}
            </span>
          ))}
          {Object.keys(card.extra_data ?? {}).length ? (
            <span className="rounded-md bg-data-soft px-1.5 py-0.5 text-[10px] font-medium text-data">
              +meta
            </span>
          ) : null}
          {card.comment_count > 0 ? (
            <span className="ml-auto flex items-center gap-1 font-mono text-[10.5px] tabular-nums text-mute-2">
              <CommentIcon />
              {card.comment_count}
            </span>
          ) : null}
        </div>
      )}
      <button
        onClick={onEdit}
        className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded-md text-mute-2 opacity-0 transition hover:bg-bg-2 hover:text-ink group-hover:flex group-hover:opacity-100"
        title="Edit card"
        aria-label="Edit"
      >
        <EditIcon />
      </button>
    </article>
  );
}

function PriorityChip({ priority }: { priority: number | null }) {
  if (priority == null) {
    return <span className="font-mono text-[10px] text-mute-2">—</span>;
  }
  const color = priorityColor(priority);
  return (
    <span
      className="flex items-center gap-1 font-mono text-[10px] font-semibold tabular-nums"
      style={{ color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />P
      {priority}
    </span>
  );
}

function priorityColor(priority: number | null): string {
  if (priority == null) return "var(--color-mute-2)";
  if (priority <= 1) return "var(--color-err)";
  if (priority === 2) return "#ea580c";
  if (priority === 3) return "var(--color-warn)";
  if (priority === 4) return "var(--color-info)";
  return "var(--color-ok)";
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Activity panel                                                          */
/* ──────────────────────────────────────────────────────────────────────── */

function ActivityPanel({
  tab,
  setTab,
  collapsed,
  setCollapsed,
  status,
  worktrees,
  runs,
  logs,
  filteredLogs,
  filters,
  setFilters,
  showNoiseLogs,
  setShowNoiseLogs,
  logsPaused,
  setLogsPaused,
  errorCount,
  filtersActive,
  levelOptions,
  eventOptions,
  agentOptions,
  fetchedAt,
}: {
  tab: ActivityTab;
  setTab: (tab: ActivityTab) => void;
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
  status: Status | null;
  worktrees: WorktreeGroup[];
  runs: AgentRun[];
  logs: LogRecord[];
  filteredLogs: LogRecord[];
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  showNoiseLogs: boolean;
  setShowNoiseLogs: React.Dispatch<React.SetStateAction<boolean>>;
  logsPaused: boolean;
  setLogsPaused: React.Dispatch<React.SetStateAction<boolean>>;
  errorCount: number;
  filtersActive: boolean;
  levelOptions: string[];
  eventOptions: string[];
  agentOptions: string[];
  fetchedAt: number | null;
}) {
  const tabs: Array<{ id: ActivityTab; label: string; count: number }> = [
    { id: "agents", label: "Running agents", count: status?.running.length ?? 0 },
    { id: "worktrees", label: "Worktrees", count: worktrees.length },
    { id: "log", label: "Event log", count: filteredLogs.length },
    { id: "retries", label: "Retry queue", count: status?.retries.length ?? 0 },
    { id: "runs", label: "Recent runs", count: runs.length },
  ];

  return (
    <section className="mt-7 overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow-flat)]">
      <header className="flex items-center justify-between gap-3 border-b border-border pl-2 pr-3">
        <nav className="flex items-end gap-0 overflow-x-auto no-scrollbar">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? "is-active" : ""}`}
              onClick={() => {
                setTab(t.id);
                setCollapsed(false);
              }}
            >
              {t.label}
              <span className="count">{t.count}</span>
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2 py-2">
          {errorCount > 0 ? (
            <button
              className="flex h-7 items-center gap-1.5 rounded-md bg-err-soft px-2 text-[11.5px] font-medium text-err transition hover:bg-err-soft/70"
              onClick={() => {
                setTab("log");
                setFilters((c) => ({ ...c, level: c.level === "error" ? "" : "error" }));
              }}
              title="Show errors only"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-err" />
              {errorCount} error{errorCount === 1 ? "" : "s"}
            </button>
          ) : null}
          <button
            className="icon-btn h-7 w-7"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? "Expand" : "Collapse"}
            aria-label={collapsed ? "Expand activity panel" : "Collapse activity panel"}
          >
            <span className={`inline-block transition-transform ${collapsed ? "" : "rotate-180"}`}>
              <ChevronDown />
            </span>
          </button>
        </div>
      </header>

      {!collapsed ? (
        <div className="reveal">
          {tab === "agents" && <AgentsPane status={status} fetchedAt={fetchedAt} />}
          {tab === "worktrees" && <WorktreesPane worktrees={worktrees} />}
          {tab === "log" && (
            <LogPane
              logs={logs}
              filteredLogs={filteredLogs}
              filters={filters}
              setFilters={setFilters}
              showNoiseLogs={showNoiseLogs}
              setShowNoiseLogs={setShowNoiseLogs}
              logsPaused={logsPaused}
              setLogsPaused={setLogsPaused}
              filtersActive={filtersActive}
              levelOptions={levelOptions}
              eventOptions={eventOptions}
              agentOptions={agentOptions}
            />
          )}
          {tab === "retries" && <RetriesPane status={status} />}
          {tab === "runs" && <RunsPane runs={runs} />}
        </div>
      ) : null}
    </section>
  );
}

function AgentsPane({ status, fetchedAt }: { status: Status | null; fetchedAt: number | null }) {
  if (!status?.running.length) {
    return (
      <Empty
        icon={<AgentIcon />}
        title="No agents running"
        body="The orchestrator is idle. Drop a card into an active state to dispatch an agent."
      />
    );
  }
  return (
    <div className="grid gap-2.5 p-3 stagger md:grid-cols-2 xl:grid-cols-1">
      {status.running.map((agent) => (
        <AgentCard key={agent.agent_id} agent={agent} fetchedAt={fetchedAt} />
      ))}
    </div>
  );
}

function WorktreesPane({ worktrees }: { worktrees: WorktreeGroup[] }) {
  const [selection, setSelection] = useState<WorktreeSelection | null>(() =>
    worktrees[0] ? { kind: "worktree", worktreePath: worktrees[0].path } : null,
  );
  const selectedWorktree = useMemo(
    () =>
      worktrees.find((worktree) => worktree.path === selection?.worktreePath) ??
      worktrees[0] ??
      null,
    [selection?.worktreePath, worktrees],
  );
  const selectedRun = useMemo(
    () => (selectedWorktree ? runTargetForSelection(selectedWorktree, selection) : null),
    [selectedWorktree, selection],
  );

  useEffect(() => {
    if (!worktrees.length) {
      setSelection(null);
      return;
    }
    if (!selection || !worktrees.some((worktree) => worktree.path === selection.worktreePath)) {
      setSelection({ kind: "worktree", worktreePath: worktrees[0]!.path });
    }
  }, [selection, worktrees]);

  if (!worktrees.length) {
    return (
      <Empty
        icon={<FolderIcon />}
        title="No worktrees assigned"
        body="Worktrees appear here after an agent claims a ticket and prepares its workspace."
      />
    );
  }
  return (
    <div className="grid min-h-[42rem] grid-cols-[360px_minmax(0,1fr)] border-t border-border bg-surface">
      <aside className="min-w-0 border-r border-border bg-surface-2">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-mute-2">
            Explorer
          </div>
          <span className="font-mono text-[10px] text-mute">{worktrees.length} worktrees</span>
        </div>
        <div className="max-h-[54rem] overflow-auto py-2">
          {worktrees.map((worktree) => (
            <WorktreeExplorerNode
              key={worktree.path}
              worktree={worktree}
              selection={selection}
              onSelect={setSelection}
            />
          ))}
        </div>
      </aside>
      <WorktreeDetail worktree={selectedWorktree} selection={selection} run={selectedRun} />
    </div>
  );
}

function WorktreeExplorerNode({
  worktree,
  selection,
  onSelect,
}: {
  worktree: WorktreeGroup;
  selection: WorktreeSelection | null;
  onSelect: (selection: WorktreeSelection) => void;
}) {
  const isSelected = selection?.worktreePath === worktree.path && selection.kind === "worktree";
  return (
    <div className="border-b border-border/70 pb-1 last:border-b-0">
      <ExplorerRow
        active={isSelected}
        icon={<ChevronDown />}
        label={worktree.workspaceKey ?? "worktree"}
        meta={`${worktree.runs.length} run${worktree.runs.length === 1 ? "" : "s"}`}
        sublabel={worktree.path}
        depth={0}
        onClick={() => onSelect({ kind: "worktree", worktreePath: worktree.path })}
      />
      <div className="py-1">
        <ExplorerRow
          active={selection?.worktreePath === worktree.path && selection.kind === "files"}
          icon={<FolderIcon />}
          label="File system"
          meta="all files / changes"
          depth={1}
          onClick={() => onSelect({ kind: "files", worktreePath: worktree.path })}
        />
        <ExplorerRow
          active={false}
          icon={<ChevronDown />}
          label="Agents"
          meta={String(worktree.runningAgents.length)}
          depth={1}
          onClick={() => onSelect({ kind: "worktree", worktreePath: worktree.path })}
        />
        {worktree.runningAgents.length ? (
          worktree.runningAgents.map((agent) => (
            <ExplorerRow
              key={agent.agent_id}
              active={
                selection?.worktreePath === worktree.path &&
                selection.kind === "agent" &&
                selection.agentId === agent.agent_id
              }
              icon={<AgentIcon />}
              label={agent.agent_id}
              meta={agent.last_codex_event ?? agent.status}
              depth={2}
              onClick={() =>
                onSelect({ kind: "agent", worktreePath: worktree.path, agentId: agent.agent_id })
              }
            />
          ))
        ) : (
          <ExplorerRow
            active={false}
            icon={<span />}
            label="No agents running"
            depth={2}
            muted
            onClick={() => onSelect({ kind: "worktree", worktreePath: worktree.path })}
          />
        )}
        <ExplorerRow
          active={false}
          icon={<ChevronDown />}
          label="Tickets"
          meta={String(worktree.assignedCards.length)}
          depth={1}
          onClick={() => onSelect({ kind: "worktree", worktreePath: worktree.path })}
        />
        {worktree.assignedCards.map((card) => (
          <ExplorerRow
            key={card.id}
            active={
              selection?.worktreePath === worktree.path &&
              selection.kind === "ticket" &&
              selection.cardId === card.id
            }
            icon={<DocIcon />}
            label={`${card.identifier} ${card.title}`}
            meta={card.state}
            depth={2}
            onClick={() =>
              onSelect({ kind: "ticket", worktreePath: worktree.path, cardId: card.id })
            }
          />
        ))}
      </div>
    </div>
  );
}

function ExplorerRow({
  active,
  icon,
  label,
  meta,
  sublabel,
  depth,
  muted,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  meta?: string;
  sublabel?: string;
  depth: number;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-1.5 px-3 py-1.5 text-left transition hover:bg-bg-2 ${active ? "bg-info-soft text-info" : muted ? "text-mute" : "text-ink-3"}`}
      style={{ paddingLeft: `${12 + depth * 18}px` }}
      onClick={onClick}
    >
      <span className="pt-0.5 text-mute-2">{icon}</span>
      <span className="min-w-0">
        <span className={`block truncate text-[12px] ${muted ? "italic" : "font-medium"}`}>
          {label}
        </span>
        {sublabel ? (
          <span className="block truncate font-mono text-[10px] text-mute-2" title={sublabel}>
            {sublabel}
          </span>
        ) : null}
      </span>
      {meta ? <span className="pt-0.5 font-mono text-[10px] text-mute-2">{meta}</span> : null}
    </button>
  );
}

function WorktreeDetail({
  worktree,
  selection,
  run,
}: {
  worktree: WorktreeGroup | null;
  selection: WorktreeSelection | null;
  run: Pick<AgentRun, "id" | "identifier" | "workspace_path"> | null;
}) {
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [showChangesOnly, setShowChangesOnly] = useState(false);

  async function loadDiff() {
    if (!run) return;
    setDiffLoading(true);
    setDiffError(null);
    try {
      setDiff(await apiJson<WorkspaceDiff>(`/api/orchestrator/runs/${run.id}/diff`));
    } catch (caught) {
      setDiffError(errorMessage(caught));
    } finally {
      setDiffLoading(false);
    }
  }

  useEffect(() => {
    setDiff(null);
    setDiffError(null);
    setShowChangesOnly(selection?.kind === "ticket");
  }, [run?.id, selection?.kind]);

  useEffect(() => {
    if (run?.workspace_path) void loadDiff();
  }, [run?.id, run?.workspace_path]);

  if (!worktree) {
    return (
      <Empty
        icon={<FolderIcon />}
        title="No worktree selected"
        body="Select a worktree to inspect agents, files, tickets, and diffs."
      />
    );
  }

  const selectedCard =
    selection?.kind === "ticket"
      ? (worktree.assignedCards.find((card) => card.id === selection.cardId) ?? null)
      : null;
  const selectedAgent =
    selection?.kind === "agent"
      ? (worktree.runningAgents.find((agent) => agent.agent_id === selection.agentId) ?? null)
      : null;
  const title = selectedCard
    ? `${selectedCard.identifier} ${selectedCard.title}`
    : selectedAgent
      ? selectedAgent.agent_id
      : (worktree.workspaceKey ?? "Worktree");
  const subtitle = selectedCard
    ? selectedCard.state
    : selectedAgent
      ? selectedAgent.status
      : worktree.path;

  return (
    <section className="min-w-0 bg-surface">
      <header className="flex min-w-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-mute-2">
              <FolderIcon />
            </span>
            <h3 className="truncate text-[14px] font-semibold tracking-tight text-ink-2">
              {title}
            </h3>
          </div>
          <div
            className="mt-0.5 truncate font-mono text-[10.5px] text-mute-2"
            title={worktree.path}
          >
            {subtitle}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-bg-2 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-ink-2">
            {worktree.workspaceKey ?? "worktree"}
          </span>
          {worktree.runningAgents.length ? (
            <span className="pill border-info/20 bg-info-soft text-info">
              {worktree.runningAgents.length} running
            </span>
          ) : null}
          <span className="font-mono text-[10.5px] text-mute">
            {worktree.runs.length} run{worktree.runs.length === 1 ? "" : "s"}
          </span>
        </div>
      </header>
      <div className="p-4">
        <RunChangeViewer
          run={run}
          diff={diff}
          loading={diffLoading}
          error={diffError}
          onLoad={() => void loadDiff()}
          showChangesOnly={showChangesOnly}
          onShowChangesOnlyChange={setShowChangesOnly}
          compact={false}
        />
      </div>
    </section>
  );
}

function RetriesPane({ status }: { status: Status | null }) {
  if (!status?.retries.length) {
    return (
      <Empty
        icon={<RetryIcon />}
        title="No retries queued"
        body="When a run fails recoverably, it will appear here with its backoff timer."
      />
    );
  }
  return (
    <div className="grid gap-2.5 p-3 stagger md:grid-cols-2">
      {status.retries.map((retry) => (
        <RetryRow key={retry.issue_id} retry={retry} />
      ))}
    </div>
  );
}

function RunsPane({ runs }: { runs: AgentRun[] }) {
  if (!runs.length) {
    return (
      <Empty
        icon={<HistoryIcon />}
        title="No completed runs"
        body="Recent agent runs and their summaries will appear here."
      />
    );
  }
  return (
    <div className="grid gap-2.5 p-3 stagger md:grid-cols-2 2xl:grid-cols-3">
      {runs.slice(0, 12).map((run) => (
        <RunSummaryCard key={run.id} run={run} />
      ))}
    </div>
  );
}

function LogPane({
  logs,
  filteredLogs,
  filters,
  setFilters,
  showNoiseLogs,
  setShowNoiseLogs,
  logsPaused,
  setLogsPaused,
  filtersActive,
  levelOptions,
  eventOptions,
  agentOptions,
}: {
  logs: LogRecord[];
  filteredLogs: LogRecord[];
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  showNoiseLogs: boolean;
  setShowNoiseLogs: React.Dispatch<React.SetStateAction<boolean>>;
  logsPaused: boolean;
  setLogsPaused: React.Dispatch<React.SetStateAction<boolean>>;
  filtersActive: boolean;
  levelOptions: string[];
  eventOptions: string[];
  agentOptions: string[];
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
        <div className="relative w-full max-w-xs">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mute-2">
            <SearchIcon />
          </span>
          <input
            className="input h-8 pl-8 text-[12px]"
            placeholder="Filter messages…"
            value={filters.search}
            onChange={(event) =>
              setFilters((current) => ({ ...current, search: event.target.value }))
            }
          />
        </div>
        <select
          className="input h-8 w-auto min-w-[110px] text-[12px]"
          value={filters.level}
          onChange={(event) => setFilters((current) => ({ ...current, level: event.target.value }))}
        >
          <option value="">All levels</option>
          {levelOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <select
          className="input h-8 w-auto min-w-[140px] text-[12px]"
          value={filters.event}
          onChange={(event) => setFilters((current) => ({ ...current, event: event.target.value }))}
        >
          <option value="">All events</option>
          {eventOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <select
          className="input h-8 w-auto min-w-[120px] text-[12px]"
          value={filters.agent}
          onChange={(event) => setFilters((current) => ({ ...current, agent: event.target.value }))}
        >
          <option value="">All agents</option>
          {agentOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="font-mono text-[11px] tabular-nums text-mute">
            <span className="text-ink">{filteredLogs.length}</span> / {logs.length}
          </span>
          {filtersActive ? (
            <button
              className="btn-soft h-7 px-2 text-[11.5px]"
              onClick={() => setFilters(emptyFilters)}
            >
              Clear
            </button>
          ) : null}
          <button
            className={`btn-soft h-7 px-2 text-[11.5px] ${!showNoiseLogs ? "bg-ink text-bg hover:bg-ink-2" : ""}`}
            onClick={() => setShowNoiseLogs((value) => !value)}
            title="Filter out noisy lifecycle events"
          >
            {showNoiseLogs ? "All events" : "Signal only"}
          </button>
          <button
            className={`btn-soft h-7 px-2 text-[11.5px] ${logsPaused ? "bg-warn-soft text-warn hover:bg-warn-soft" : ""}`}
            onClick={() => setLogsPaused((value) => !value)}
          >
            {logsPaused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>
      <LogTable
        logs={filteredLogs}
        onPickAgent={(agent_id) => setFilters((current) => ({ ...current, agent: agent_id }))}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Cards (Agent / Retry / Run)                                             */
/* ──────────────────────────────────────────────────────────────────────── */

function AgentCard({ agent, fetchedAt }: { agent: RunningAgent; fetchedAt: number | null }) {
  const [open, setOpen] = useState(false);
  const elapsed = useLiveElapsed(agent.elapsed_ms, fetchedAt);
  return (
    <article className="overflow-hidden rounded-lg border border-border bg-surface transition hover:border-border-2">
      <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border px-3 py-2">
        <span className="rounded-md bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-2">
          {agent.agent_id}
        </span>
        <StatusPill status={agent.status} />
        <span className="font-mono text-[11px] uppercase tracking-wider text-mute-2">
          {agent.issue.identifier}
        </span>
        <span className="truncate text-[13px] font-medium tracking-tight">{agent.issue.title}</span>
        <span className="ml-auto flex items-center gap-3 font-mono text-[11px] tabular-nums text-mute">
          <MetricChip label="elapsed" value={formatDuration(elapsed)} />
          <MetricChip label="turns" value={agent.turn_count} />
          <MetricChip label="tok" value={formatNumber(agent.tokens.total)} />
        </span>
      </header>
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-2.5 text-[12px]">
        <Term>Command</Term>
        <Detail mono>{agent.command}</Detail>
        <Term>Workspace</Term>
        <Detail mono>{agent.workspace_path || "—"}</Detail>
        <Term>Model</Term>
        <Detail>
          {agent.model ?? <span className="text-mute-2">config default</span>}
          {agent.profile ? <span className="text-mute-2"> · profile {agent.profile}</span> : null}
        </Detail>
        <Term>Last event</Term>
        <Detail>
          {agent.last_codex_event ? (
            <code className="rounded bg-data-soft px-1.5 py-0.5 font-mono text-[11px] text-data">
              {agent.last_codex_event}
            </code>
          ) : (
            <span className="text-mute-2">—</span>
          )}
          {agent.last_codex_message ? (
            <span className="ml-2 text-ink-3">{truncate(agent.last_codex_message, 140)}</span>
          ) : null}
        </Detail>
      </dl>
      {agent.prompt_preview ? (
        <div className="border-t border-border bg-surface-2 px-3 py-2">
          <button
            onClick={() => setOpen((value) => !value)}
            className="flex items-center gap-1.5 text-[11.5px] font-medium text-mute hover:text-ink"
          >
            <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>
              <ChevronRight />
            </span>
            {open ? "Hide prompt preview" : "Show prompt preview"}
          </button>
          {open ? (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-ink p-3 font-mono text-[11px] leading-relaxed text-bg scrollbar-thin">
              {agent.prompt_preview}
            </pre>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function MetricChip({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-mute-2">{label}</span>
      <span className="font-medium text-ink-2">{value}</span>
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone = statusTone(status);
  return <span className={`pill ${tone}`}>{status}</span>;
}

function statusTone(status: string): string {
  switch (status) {
    case "Succeeded":
      return "border-ok/20 bg-ok-soft text-ok";
    case "Failed":
    case "TimedOut":
    case "Stalled":
      return "border-err/20 bg-err-soft text-err";
    case "CanceledByReconciliation":
      return "border-border-2 bg-bg-2 text-mute";
    case "StreamingTurn":
    case "LaunchingAgentProcess":
      return "border-info/20 bg-info-soft text-info";
    case "PreparingWorkspace":
    case "BuildingPrompt":
    case "Finishing":
      return "border-data/20 bg-data-soft text-data";
    default:
      return "border-border-2 bg-bg-2 text-ink-3";
  }
}

function Term({ children }: { children: React.ReactNode }) {
  return (
    <dt className="text-[10.5px] font-medium uppercase tracking-wider text-mute-2 pt-0.5">
      {children}
    </dt>
  );
}

function Detail({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <dd className={`break-all text-ink-2 ${mono ? "mono" : "text-[12px] leading-snug"}`}>
      {children}
    </dd>
  );
}

function RetryRow({ retry }: { retry: Retry }) {
  const due = new Date(retry.due_at);
  const dueIn = Math.max(0, due.getTime() - Date.now());
  return (
    <article className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-mute-2">
          {retry.identifier}
        </span>
        <span className="pill border-warn/20 bg-warn-soft text-warn">attempt {retry.attempt}</span>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-mute">
          due in <span className="text-warn">{formatDuration(dueIn)}</span> ·{" "}
          {due.toLocaleTimeString()}
        </span>
      </div>
      <p className="mt-1.5 break-words text-[12px] text-ink-3">
        {retry.error ?? "continuation check"}
      </p>
    </article>
  );
}

function RunSummaryCard({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false);
  const lastEvents = signalRunEvents(run.events).slice(-5);
  const summarySource = run.summary || run.error;
  const summaryParsed = summarySource ? tryParseJson(summarySource) : null;
  const feedback = runFeedback(run);

  return (
    <article className="flex min-h-[154px] flex-col overflow-hidden rounded-lg border border-border bg-surface transition hover:border-border-2">
      <header className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="rounded-md bg-bg-2 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-ink-2">
          {run.agent_id}
        </span>
        <StatusPill status={run.status} />
        <span className="truncate font-mono text-[10.5px] uppercase tracking-wider text-mute-2">
          {run.identifier}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px] tabular-nums text-mute">
          {run.runtime_ms ? formatDuration(run.runtime_ms) : formatRelative(run.started_at)}
        </span>
      </header>
      <div className="flex flex-1 flex-col px-3 py-2.5">
        <div className="min-h-[58px]">
          <div className="mb-1 flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${run.status === "Succeeded" ? "bg-ok" : run.status === "Failed" ? "bg-err" : "bg-info"}`}
              aria-hidden
            />
            <span className="text-[12px] font-semibold tracking-tight text-ink-2">
              {feedback.title}
            </span>
          </div>
          <p
            className={`whitespace-pre-wrap text-[12px] leading-snug ${feedback.kind === "empty" ? "italic text-mute" : feedback.kind === "error" ? "text-err" : "text-ink-3"} line-clamp-3`}
          >
            {feedback.body}
          </p>
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 font-mono text-[10.5px] tabular-nums text-mute">
          <span title={`${run.input_tokens} input / ${run.output_tokens} output`}>
            <span className="font-semibold text-ink-2">{formatNumber(run.total_tokens)}</span>{" "}
            tokens
          </span>
          {run.moved_to_state ? (
            <span className="flex items-center gap-1">
              <span aria-hidden>→</span>
              <span className="font-semibold text-ink-2">{run.moved_to_state}</span>
            </span>
          ) : null}
          <span>
            <span className="font-semibold text-ink-2">{lastEvents.length}</span> signals
          </span>
          {lastEvents.length ? (
            <button
              type="button"
              className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-ink-2 transition hover:bg-bg-2"
              onClick={() => setOpen((value) => !value)}
            >
              <span className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>
                <ChevronRight />
              </span>
              details
            </button>
          ) : null}
        </div>
      </div>
      {open ? (
        <div className="max-h-56 overflow-auto border-t border-border bg-surface-2 px-3 py-2">
          {lastEvents.length ? (
            <ol className="space-y-1">
              {lastEvents.map((event) => (
                <li
                  key={event.id}
                  className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 font-mono text-[10.5px]"
                >
                  <span className="tabular-nums text-mute-2">
                    {new Date(event.created_at).toLocaleTimeString()}
                  </span>
                  <span className="truncate text-ink-3">
                    <span className="font-medium text-data">{eventLabel(event)}</span>
                    {event.message ? <span className="text-mute"> · {event.message}</span> : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {summaryParsed ? (
            <details className="mt-2 rounded-md border border-border bg-surface px-2 py-1.5">
              <summary className="cursor-pointer text-[10.5px] font-semibold uppercase tracking-wider text-mute-2">
                Raw event
              </summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[10.5px] leading-snug text-ink-3 scrollbar-thin">
                {compactJson(summaryParsed)}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function runFeedback(run: AgentRun): {
  title: string;
  body: string;
  kind: "ok" | "error" | "empty" | "structured";
} {
  const summarySource = run.summary || run.error || "";
  if (!summarySource.trim()) {
    return {
      title: statusLabel(run.status),
      body:
        run.status === "Succeeded"
          ? "Run finished, but the agent did not provide a final summary."
          : "No summary captured yet.",
      kind: "empty",
    };
  }

  const parsed = tryParseJson(summarySource);
  if (!parsed) {
    return {
      title: run.error ? "Run failed" : "Agent summary",
      body: truncate(summarySource.trim(), 360),
      kind: run.error ? "error" : "ok",
    };
  }

  const usefulText = extractHumanText(parsed);
  if (usefulText) {
    return {
      title: run.error ? "Run failed" : "Agent summary",
      body: truncate(usefulText, 360),
      kind: run.error ? "error" : "ok",
    };
  }

  const type =
    jsonStringAt(parsed, "type") ??
    jsonStringAt(parsed, "item.type") ??
    jsonStringAt(parsed, "event.type");
  if (type === "turn.completed") {
    const total = usageTotal(parsed) || run.total_tokens;
    return {
      title: "Turn completed",
      body: total
        ? `Codex finished the turn using ${formatNumber(total)} tokens. No human final summary was emitted.`
        : "Codex finished the turn. No human final summary was emitted.",
      kind: "structured",
    };
  }
  if (type === "item.completed") {
    const command = jsonStringAt(parsed, "item.command.command") ?? jsonStringAt(parsed, "command");
    return {
      title: "Command completed",
      body: command
        ? truncate(command, 260)
        : "Codex completed a command item. Open details to inspect the raw event.",
      kind: "structured",
    };
  }

  return {
    title: type ? eventTitle(type) : "Structured event",
    body: "The run captured a structured Codex event instead of a final summary. Open details to inspect the raw event.",
    kind: "structured",
  };
}

function signalRunEvents(events: AgentRunEvent[]) {
  const noisy = new Set([
    "item.started",
    "item.completed",
    "thread.started",
    "turn.started",
    "process.started",
  ]);
  return events.filter((event) => {
    if (event.level === "error" || event.level === "warn") return true;
    if (event.message || event.data?.error) return true;
    return !noisy.has(event.event_type);
  });
}

function eventLabel(event: AgentRunEvent) {
  return event.event_type === "codex_event" && typeof event.data?.codex_event_type === "string"
    ? eventTitle(event.data.codex_event_type)
    : eventTitle(event.event_type);
}

function eventTitle(value: string) {
  return value
    .replace(/^codex_/, "")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusLabel(status: string) {
  return eventTitle(status);
}

function extractHumanText(value: unknown): string {
  const direct = firstStringAt(value, [
    "summary",
    "message",
    "final_answer",
    "answer",
    "text",
    "output",
  ]);
  if (direct && !looksLikeJson(direct)) return direct.trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const item = record.item;
    if (item && typeof item === "object") {
      const nested = firstStringAt(item, ["summary", "message", "text", "output"]);
      if (nested && !looksLikeJson(nested)) return nested.trim();
    }
  }
  return "";
}

function firstStringAt(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) return field;
  }
  return "";
}

function jsonStringAt(value: unknown, pathValue: string) {
  let current: unknown = value;
  for (const part of pathValue.split(".")) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : null;
}

function usageTotal(value: unknown) {
  if (!value || typeof value !== "object") return 0;
  const usage = (value as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return 0;
  const total = (usage as Record<string, unknown>).total_tokens;
  if (typeof total === "number") return total;
  const input = (usage as Record<string, unknown>).input_tokens;
  const output = (usage as Record<string, unknown>).output_tokens;
  return (typeof input === "number" ? input : 0) + (typeof output === "number" ? output : 0);
}

function looksLikeJson(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function tryParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Log table                                                               */
/* ──────────────────────────────────────────────────────────────────────── */

function LogTable({
  logs,
  onPickAgent,
}: {
  logs: LogRecord[];
  onPickAgent: (agentId: string) => void;
}) {
  if (!logs.length) {
    return (
      <div className="px-5 py-12 text-center text-[12.5px] text-mute">
        No log events match the current filters.
      </div>
    );
  }
  return (
    <div className="max-h-[52vh] min-h-64 overflow-auto bg-surface scrollbar-thin">
      <div className="sticky top-0 z-10 grid grid-cols-[80px_60px_180px_140px_minmax(0,1fr)] items-start gap-3 border-b border-border bg-surface-2 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-mute backdrop-blur">
        <span>Time</span>
        <span>Level</span>
        <span>Event</span>
        <span>Agent / Card</span>
        <span>Detail</span>
      </div>
      {logs.map((log) => (
        <LogRow key={logKey(log)} log={log} onPickAgent={onPickAgent} />
      ))}
    </div>
  );
}

function LogRow({ log, onPickAgent }: { log: LogRecord; onPickAgent: (agentId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const detail = logDetail(log);
  const isError = log.level === "error" || Boolean(log.error);
  const isWarn = log.level === "warn";
  const expandable = isError || (detail?.length ?? 0) > 180;
  return (
    <div
      className={`grid cursor-default grid-cols-[80px_60px_180px_140px_minmax(0,1fr)] items-start gap-3 border-b border-border px-3 py-1.5 transition hover:bg-surface-2 ${isError ? "bg-err-soft/40" : isWarn ? "bg-warn-soft/40" : ""}`}
      onClick={() => expandable && setExpanded((value) => !value)}
    >
      <span className="font-mono text-[11px] tabular-nums text-mute-2">
        {new Date(log.ts).toLocaleTimeString()}
      </span>
      <span
        className={`inline-flex h-[18px] max-w-fit items-center rounded px-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider ${levelClass(log.level)}`}
      >
        {log.level}
      </span>
      <span className="truncate font-mono text-[11px] text-data" title={log.event}>
        {log.event}
      </span>
      <span
        className="truncate font-mono text-[11px] text-ink-2 hover:underline"
        onClick={(event) => {
          if (log.agent_id) {
            event.stopPropagation();
            onPickAgent(log.agent_id);
          }
        }}
        title={log.agent_id ? "Filter by this agent" : ""}
      >
        {log.agent_id ?? log.identifier ?? <span className="text-mute-2">—</span>}
      </span>
      <span className="min-w-0 break-words font-mono text-[11.5px] leading-snug text-ink-2">
        {expanded ? (
          <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
            {JSON.stringify(log, null, 2)}
          </pre>
        ) : (
          <span className={expandable ? "line-clamp-2 whitespace-pre-wrap" : "whitespace-pre-wrap"}>
            {detail}
          </span>
        )}
        {expandable && !expanded ? (
          <span className="ml-2 text-[10px] text-mute-2">expand</span>
        ) : null}
      </span>
    </div>
  );
}

function logKey(log: LogRecord) {
  return [
    log.ts,
    log.level,
    log.event,
    log.agent_id ?? "",
    log.identifier ?? "",
    log.issue_id ?? "",
    log.codex_event_type ?? "",
    log.message ?? "",
  ].join("|");
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Workflow editor                                                         */
/* ──────────────────────────────────────────────────────────────────────── */

function WorkflowEditorPanel({ onClose }: { onClose: () => void }) {
  const { resolvedTheme } = useThemePreference();
  const [document, setDocument] = useState<WorkflowDocument | null>(null);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = document !== null && source !== document.source;

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    apiJson<WorkflowDocument>("/api/workflow")
      .then((payload) => {
        if (canceled) return;
        setDocument(payload);
        setSource(payload.source);
      })
      .catch((caught) => {
        if (!canceled) setError(errorMessage(caught));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, []);

  async function saveWorkflow() {
    setSaving(true);
    setError(null);
    try {
      const saved = await apiJson<WorkflowDocument>("/api/workflow", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      });
      setDocument(saved);
      setSource(saved.source);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-ink/20 backdrop-blur-sm reveal" onClick={onClose}>
      <section
        className="ml-auto grid h-full w-full max-w-6xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-l border-border bg-surface shadow-[var(--shadow-modal)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-data-soft text-data">
                <DocIcon />
              </span>
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold tracking-tight">Workflow</h2>
                <p className="truncate font-mono text-[10.5px] text-mute-2">
                  {document?.path ?? "WORKFLOW.md"}
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {document?.updatedAt ? (
              <span className="hidden font-mono text-[10.5px] text-mute sm:inline">
                {new Date(document.updatedAt).toLocaleTimeString()}
              </span>
            ) : null}
            {dirty ? (
              <span className="pill border-warn/20 bg-warn-soft text-warn">edited</span>
            ) : null}
            <button className="btn-soft" onClick={onClose}>
              Close
            </button>
            <button
              className="btn-primary"
              disabled={!dirty || saving || loading}
              onClick={() => void saveWorkflow()}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </header>

        <div className="min-h-0 overflow-hidden p-3">
          {error ? (
            <div className="mb-3 rounded-lg border border-err/20 bg-err-soft px-3 py-2 text-[12px] text-err">
              {error}
            </div>
          ) : null}
          {loading ? (
            <div className="grid h-full place-items-center text-[12px] text-mute">
              Loading workflow...
            </div>
          ) : (
            <div className="workflow-editor h-full" data-color-mode={resolvedTheme}>
              <MDEditor
                value={source}
                onChange={(value) => setSource(value ?? "")}
                height="100%"
                preview="live"
                textareaProps={{
                  spellCheck: false,
                  "aria-label": "Workflow markdown source",
                }}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Planner chat                                                            */
/* ──────────────────────────────────────────────────────────────────────── */

function PlannerPanel({
  session,
  input,
  busy,
  error,
  setInput,
  onSubmit,
  onCreate,
  onClose,
  onRestart,
}: {
  session: PlannerSession | null;
  input: string;
  busy: boolean;
  error: string | null;
  setInput: (value: string) => void;
  onSubmit: (event?: React.FormEvent) => void;
  onCreate: () => void;
  onClose: () => void;
  onRestart: () => void;
}) {
  const draft = session?.draft;
  return (
    <div className="fixed inset-0 z-40 bg-ink/20 backdrop-blur-sm reveal" onClick={onClose}>
      <section
        className="ml-auto grid h-full w-full max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden border-l border-border bg-surface shadow-[var(--shadow-modal)] lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_minmax(0,1fr)_auto]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 lg:col-span-2">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-info-soft text-info">
              <ChatIcon />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold tracking-tight">Planning agent</h2>
              <p className="text-[12px] text-mute">
                Chat through the work, then create a structured Kanban card.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost" onClick={onRestart} disabled={busy}>
              Restart
            </button>
            <button
              type="button"
              className="icon-btn h-7 w-7 text-[14px]"
              onClick={onClose}
              aria-label="Close"
              title="Close"
            >
              ×
            </button>
          </div>
        </header>

        <div className="min-h-0 overflow-auto bg-bg/40 p-3">
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            {session?.messages.map((messageItem) => (
              <PlannerBubble key={messageItem.id} message={messageItem} />
            ))}
            {!session && !error ? (
              <div className="rounded-lg border border-dashed border-border-2 bg-surface px-4 py-5 text-center text-[12.5px] text-mute">
                Starting planning session…
              </div>
            ) : null}
            {busy ? (
              <div className="max-w-[82%] rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px] text-mute">
                Planner is thinking…
              </div>
            ) : null}
            {error ? <PlannerError message={error} onRetry={onRestart} /> : null}
          </div>
        </div>

        <aside className="hidden min-h-0 overflow-auto border-l border-border bg-surface-2 p-4 lg:block">
          <TicketDraftPreview draft={draft} />
        </aside>

        <form className="border-t border-border bg-surface p-3 lg:col-span-2" onSubmit={onSubmit}>
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_80px_110px]">
            <textarea
              className="input min-h-14 resize-none"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Chat with the planner. It will update the draft as details become clear."
              disabled={!session || busy}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
            />
            <button
              type="submit"
              className="btn-primary h-auto min-h-9 px-4"
              disabled={!session || busy || !input.trim()}
            >
              Send
            </button>
            <button
              type="button"
              className="btn-ghost h-auto min-h-9 px-4"
              disabled={!draft?.ready || busy}
              onClick={onCreate}
            >
              Create card
            </button>
          </div>
          <div className="mt-2 lg:hidden">
            <TicketDraftPreview draft={draft} compact />
          </div>
        </form>
      </section>
    </div>
  );
}

function PlannerBubble({ message }: { message: PlannerMessage }) {
  const isUser = message.role === "user";
  return (
    <article className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[82%] rounded-lg border px-3 py-2 ${isUser ? "border-ink bg-ink text-bg" : "border-border bg-surface-2 text-ink-2"}`}
      >
        <div className="mb-1 flex items-center gap-2">
          <span
            className={`font-mono text-[10px] uppercase tracking-wider ${isUser ? "text-mute-3" : "text-mute-2"}`}
          >
            {isUser ? "you" : "planner-agent"}
          </span>
          <span className={`font-mono text-[10px] ${isUser ? "text-mute-3" : "text-mute-2"}`}>
            {new Date(message.created_at).toLocaleTimeString()}
          </span>
        </div>
        <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{message.body}</p>
      </div>
    </article>
  );
}

function PlannerError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-err/20 bg-err-soft p-3 text-[12px] text-err">
      <div className="mb-1 font-semibold">Planner API is not responding correctly</div>
      <p className="break-words">{message}</p>
      <p className="mt-2 text-err/80">
        Restart the Bun dev server so the new planner routes are loaded.
      </p>
      <button
        type="button"
        className="btn-ghost mt-2 h-7 bg-surface px-2 text-[11px]"
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}

function TicketDraftPreview({
  draft,
  compact = false,
}: {
  draft?: PlannerDraft;
  compact?: boolean;
}) {
  if (!draft) {
    return (
      <div className="rounded-lg border border-dashed border-border-2 bg-surface px-4 py-5 text-center text-[12px] text-mute">
        The ticket draft will appear here as the conversation develops.
      </div>
    );
  }
  return (
    <div className={`rounded-lg border border-border bg-surface ${compact ? "p-3" : "p-4"}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold tracking-tight">Ticket draft</h3>
        <span
          className={`pill ${draft.ready ? "border-ok/20 bg-ok-soft text-ok" : "border-warn/20 bg-warn-soft text-warn"}`}
        >
          {draft.ready ? "Ready" : "Needs detail"}
        </span>
      </div>
      <dl className="grid gap-3 text-[12px]">
        <DraftField label="Title" value={draft.title || "Not set"} />
        <DraftField label="Goal" value={draft.goal || "Not set"} />
        <DraftList
          label="Acceptance"
          items={draft.acceptance_criteria}
          empty="No acceptance criteria yet."
        />
        <DraftList label="Constraints" items={draft.constraints} empty="No constraints captured." />
        <div className="grid grid-cols-2 gap-2">
          <DraftField label="Priority" value={draft.priority ? `P${draft.priority}` : "Not set"} />
          <DraftField label="State" value={draft.state} />
        </div>
        <div>
          <dt className="mb-1 text-[10.5px] font-medium uppercase tracking-wider text-mute-2">
            Labels
          </dt>
          <dd className="flex flex-wrap gap-1.5">
            {(draft.labels.length ? draft.labels : ["planned"]).map((label) => (
              <span
                key={label}
                className="rounded-md bg-bg-2 px-1.5 py-0.5 text-[10.5px] font-medium text-mute"
              >
                {label}
              </span>
            ))}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function DraftField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="mb-1 text-[10.5px] font-medium uppercase tracking-wider text-mute-2">
        {label}
      </dt>
      <dd className="whitespace-pre-wrap rounded-md bg-surface-2 px-2 py-1.5 text-ink-2">
        {value}
      </dd>
    </div>
  );
}

function DraftList({ label, items, empty }: { label: string; items: string[]; empty: string }) {
  return (
    <div>
      <dt className="mb-1 text-[10.5px] font-medium uppercase tracking-wider text-mute-2">
        {label}
      </dt>
      <dd className="rounded-md bg-surface-2 px-2 py-1.5 text-ink-2">
        {items.length ? (
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item}>- {item}</li>
            ))}
          </ul>
        ) : (
          <span className="text-mute">{empty}</span>
        )}
      </dd>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Card Dialog (modal)                                                     */
/* ──────────────────────────────────────────────────────────────────────── */

function CardDialog({
  draft,
  columns,
  setDraft,
  onSubmit,
  onAddComment,
}: {
  draft: CardDraft;
  columns: string[];
  setDraft: (draft: CardDraft | null) => void;
  onSubmit: (event: React.FormEvent) => void;
  onAddComment: () => void;
}) {
  const labels = draft.labels
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  const stateDot = columnTone(draft.state);
  const priorityNum = draft.priority ? Number(draft.priority) : null;
  const priorityHue = priorityColor(priorityNum);

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center overflow-auto bg-ink/45 p-3 backdrop-blur-md reveal sm:p-5"
      onClick={() => setDraft(null)}
    >
      <form
        className="grid h-[88vh] max-h-[920px] min-h-[640px] w-[97vw] max-w-[1480px] grid-rows-[auto_minmax(0,1fr)_auto_auto] gap-0 overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-modal)]"
        onSubmit={onSubmit}
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header — metadata pills + big editable title */}
        <header className="border-b border-border px-6 pt-5 pb-5 md:px-8">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {draft.identifier ? (
                <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-mute-2">
                  {draft.identifier}
                </span>
              ) : (
                <span className="rounded-md bg-bg-2 px-2 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-mute">
                  New
                </span>
              )}
              <span className="text-mute-3">·</span>
              <span className="pill border-border-2 bg-surface-2 text-ink-2">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: stateDot }}
                  aria-hidden
                />
                {draft.state}
              </span>
              {priorityNum != null && !Number.isNaN(priorityNum) ? (
                <span className="pill border-border-2 bg-surface-2" style={{ color: priorityHue }}>
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: priorityHue }}
                    aria-hidden
                  />
                  P{priorityNum}
                </span>
              ) : null}
              {labels.slice(0, 4).map((label) => (
                <span
                  key={label}
                  className="rounded-md bg-bg-2 px-1.5 py-0.5 text-[10.5px] font-medium text-mute"
                >
                  {label}
                </span>
              ))}
              {labels.length > 4 ? (
                <span className="font-mono text-[10.5px] text-mute-2">+{labels.length - 4}</span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {draft.t3Links ? (
                <a
                  href={draft.t3Links.chatUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-ghost h-8 px-3 text-[11.5px]"
                  title="Open T3 chat"
                >
                  <ChatIcon />
                  T3 chat
                </a>
              ) : null}
              <button
                type="button"
                className="icon-btn h-8 w-8"
                onClick={() => setDraft(null)}
                aria-label="Close"
                title="Close (Esc)"
              >
                <CloseIcon />
              </button>
            </div>
          </div>
          <input
            className="mt-3 w-full bg-transparent text-[28px] font-semibold leading-tight tracking-tight text-ink outline-none placeholder:text-mute-3 md:text-[30px]"
            placeholder="Untitled card"
            required
            maxLength={160}
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            autoFocus={!draft.id}
          />
        </header>

        {/* Body — form fields */}
        <div className="min-h-0 overflow-auto px-6 py-5 md:px-8 md:py-6">
          <div className="mx-auto max-w-5xl">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <SectionLabel icon={<DocIcon />}>Description</SectionLabel>
                  <span className="font-mono text-[10.5px] tabular-nums text-mute-2">
                    {draft.description.length} chars
                  </span>
                </div>
                <AutoTextarea
                  className="input min-h-[200px] resize-y leading-relaxed"
                  placeholder="What's the goal of this card? Add context, acceptance criteria, links…"
                  value={draft.description}
                  onChange={(value) => setDraft({ ...draft, description: value })}
                />
              </div>

              <div>
                <SectionLabel icon={<PropertiesIcon />}>Properties</SectionLabel>
                <div className="mt-2 grid gap-3 rounded-xl border border-border bg-surface-2 p-3.5">
                  <PropField label="State">
                    <select
                      className="input bg-surface"
                      value={draft.state}
                      onChange={(event) => setDraft({ ...draft, state: event.target.value })}
                    >
                      {columns.map((column) => (
                        <option key={column}>{column}</option>
                      ))}
                    </select>
                  </PropField>
                  <PropField label="Priority">
                    <input
                      className="input bg-surface text-center font-mono"
                      type="number"
                      min="1"
                      max="5"
                      placeholder="—"
                      value={draft.priority}
                      onChange={(event) => setDraft({ ...draft, priority: event.target.value })}
                    />
                  </PropField>
                  <PropField label="Labels" hint="comma-separated">
                    <input
                      className="input bg-surface"
                      placeholder="frontend, api"
                      value={draft.labels}
                      onChange={(event) => setDraft({ ...draft, labels: event.target.value })}
                    />
                  </PropField>
                </div>
              </div>
            </div>

            <ExtraDataAccordion
              value={draft.extraData}
              onChange={(value) => setDraft({ ...draft, extraData: value })}
            />
            <CardT3Embed links={draft.t3Links} />
          </div>
        </div>

        {/* Activity — comments + run history as tables */}
        <ActivitySection draft={draft} setDraft={setDraft} onAddComment={onAddComment} />

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-2 px-6 py-3 md:px-8">
          <div className="hidden items-center gap-3 text-[11.5px] text-mute sm:flex">
            <span className="flex items-center gap-1.5">
              <kbd>Esc</kbd>
              <span>close</span>
            </span>
            <span className="text-mute-3">·</span>
            <span className="flex items-center gap-1.5">
              <kbd>⌘</kbd>
              <kbd>↵</kbd>
              <span>save</span>
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" className="btn-ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button className="btn-primary">
              {draft.id ? "Save changes" : "Create card"}
              <kbd className="hidden border-ink-3 bg-ink-2 text-mute-3 sm:inline-flex">⌘↵</kbd>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function CardT3Embed({ links }: { links: CardT3Links | null }) {
  if (!links) return null;

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2 px-3 py-2">
        <div>
          <SectionLabel icon={<ChatIcon />}>T3 chat</SectionLabel>
          <p className="mt-1 font-mono text-[10.5px] text-mute">{links.threadId}</p>
        </div>
        <a
          href={links.chatUrl}
          target="_blank"
          rel="noreferrer"
          className="btn-ghost h-7 px-2 text-[11px]"
        >
          Open chat
        </a>
      </div>
      <iframe
        title={`T3 chat ${links.threadId}`}
        src={links.embedUrl}
        className="h-[520px] w-full border-0 bg-surface"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    </section>
  );
}

function handleKeyDown(event: React.KeyboardEvent<HTMLFormElement>) {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.checkValidity()) form.requestSubmit();
  }
}

function AutoTextarea({
  value,
  onChange,
  className,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const userResizedRef = useRef(false);

  useEffect(() => {
    const textarea = ref.current;
    if (!textarea || userResizedRef.current) return;
    textarea.style.height = "auto";
    const next = Math.min(textarea.scrollHeight, 560);
    textarea.style.height = `${next}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      className={className}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onMouseDown={() => {
        const textarea = ref.current;
        if (!textarea) return;
        const startHeight = textarea.style.height;
        const onUp = () => {
          if (textarea.style.height !== startHeight) userResizedRef.current = true;
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mouseup", onUp);
      }}
    />
  );
}

function PropField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-mute-2">
          {label}
        </span>
        {hint ? <span className="text-[10px] text-mute-3">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function SectionLabel({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-mute-2">
      {icon ? <span className="text-mute-2">{icon}</span> : null}
      {children}
    </div>
  );
}

function ExtraDataAccordion({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const trimmed = value.trim();
  const hasContent = Boolean(trimmed && trimmed !== "{}");
  const [open, setOpen] = useState(hasContent);
  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 bg-surface-2 px-3 py-2 text-left transition hover:bg-bg-2"
      >
        <span className={`inline-block text-mute transition-transform ${open ? "rotate-90" : ""}`}>
          <ChevronRight />
        </span>
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-mute-2">
          Extra data
        </span>
        <span className="rounded bg-data-soft px-1.5 py-0.5 font-mono text-[9.5px] font-medium text-data">
          JSON
        </span>
        {hasContent && !open ? (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-mute">
            <span className="h-1.5 w-1.5 rounded-full bg-data" aria-hidden />
            set
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="border-t border-border bg-surface p-3">
          <textarea
            className="input min-h-24 font-mono text-[12px]"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={'{\n  "repo": "...",\n  "acceptance": "..."\n}'}
          />
        </div>
      ) : null}
    </div>
  );
}

function ActivitySection({
  draft,
  setDraft,
  onAddComment,
}: {
  draft: CardDraft;
  setDraft: (draft: CardDraft | null) => void;
  onAddComment: () => void;
}) {
  const [tab, setTab] = useState<"planning" | "runs">("planning");
  return (
    <section className="flex max-h-[44vh] min-h-[200px] flex-col overflow-hidden border-t border-border bg-surface-2">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-surface px-3 md:px-5">
        <nav className="flex items-end gap-0 overflow-x-auto no-scrollbar">
          <button
            type="button"
            className={`tab ${tab === "planning" ? "is-active" : ""}`}
            onClick={() => setTab("planning")}
          >
            Planning
            <span className="count">{draft.comments.length}</span>
          </button>
          <button
            type="button"
            className={`tab ${tab === "runs" ? "is-active" : ""}`}
            onClick={() => setTab("runs")}
          >
            Run history
            <span className="count">{draft.runs.length}</span>
          </button>
        </nav>
      </header>
      {tab === "planning" ? (
        <PlanningTable draft={draft} setDraft={setDraft} onAddComment={onAddComment} />
      ) : (
        <RunsTable runs={draft.runs} />
      )}
    </section>
  );
}

function PlanningTable({
  draft,
  setDraft,
  onAddComment,
}: {
  draft: CardDraft;
  setDraft: (draft: CardDraft | null) => void;
  onAddComment: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {draft.id ? (
        <div className="border-b border-border bg-surface-2 px-3 py-2.5 md:px-5">
          <div className="rounded-lg border border-border bg-surface transition focus-within:border-ink focus-within:shadow-[0_0_0_3px_rgb(10_10_10_/_0.04)]">
            <textarea
              className="block w-full resize-none bg-transparent px-3 py-2 text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-mute-2"
              rows={2}
              value={draft.newComment}
              onChange={(event) => setDraft({ ...draft, newComment: event.target.value })}
              onKeyDown={(event) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key === "Enter" &&
                  draft.newComment.trim()
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  onAddComment();
                }
              }}
              placeholder="Add a planning note, acceptance criteria, or handoff context…   ⌘↵"
            />
            <div className="flex items-center justify-between gap-2 border-t border-border bg-surface-2 px-2 py-1.5">
              <select
                className="h-7 cursor-pointer rounded-md border-transparent bg-transparent px-2 text-[11px] font-medium text-mute outline-none transition hover:bg-bg-2"
                value={draft.newCommentKind}
                onChange={(event) =>
                  setDraft({ ...draft, newCommentKind: event.target.value as CardComment["kind"] })
                }
              >
                <option value="planning">planning</option>
                <option value="comment">comment</option>
              </select>
              <button
                type="button"
                className="btn-primary h-7 px-3 text-[11.5px] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={onAddComment}
                disabled={!draft.newComment.trim()}
              >
                <ReturnIcon />
                Add
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="border-b border-border bg-surface-2 px-3 py-2 text-center text-[11.5px] text-mute md:px-5">
          Save the card to start a planning thread.
        </div>
      )}
      {draft.comments.length === 0 ? (
        <ActivityEmpty
          icon={<PlanningIcon />}
          title="No planning notes yet"
          body="Add acceptance criteria, handoff context, or instructions for the agent that picks up this card."
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="sticky top-0 z-10 grid grid-cols-[180px_110px_minmax(0,1fr)_72px] gap-3 border-b border-border bg-surface-2 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-mute md:px-5">
            <span>Author</span>
            <span>Kind</span>
            <span>Note</span>
            <span className="text-right">Time</span>
          </div>
          {draft.comments.map((comment) => (
            <PlanningRow key={comment.id} comment={comment} />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanningRow({ comment }: { comment: CardComment }) {
  const [expanded, setExpanded] = useState(false);
  const initial = (comment.author?.[0] ?? "?").toUpperCase();
  const tone = avatarColor(comment.author);
  const long = comment.body.length > 120 || comment.body.includes("\n");
  return (
    <div
      className={`grid cursor-default grid-cols-[180px_110px_minmax(0,1fr)_72px] items-start gap-3 border-b border-border bg-surface px-3 py-2 transition hover:bg-surface-2 md:px-5 ${long ? "cursor-pointer" : ""}`}
      onClick={() => long && setExpanded((value) => !value)}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white"
          style={{ backgroundColor: tone }}
          aria-hidden
        >
          {initial}
        </span>
        <span className="truncate text-[12px] font-medium text-ink-2">{comment.author}</span>
      </span>
      <span className="pt-0.5">
        <span className={`pill ${commentKindClass(comment.kind)}`}>{comment.kind}</span>
      </span>
      <span className="min-w-0 break-words text-[12px] leading-snug text-ink-2">
        <span className={expanded ? "whitespace-pre-wrap" : "line-clamp-2 whitespace-pre-wrap"}>
          {comment.body}
        </span>
        {long && !expanded ? <span className="ml-2 text-[10.5px] text-mute-2">expand</span> : null}
      </span>
      <span
        className="pt-0.5 text-right font-mono text-[10.5px] tabular-nums text-mute"
        title={new Date(comment.created_at).toLocaleString()}
      >
        {formatRelative(comment.created_at)}
      </span>
    </div>
  );
}

function RunsTable({ runs }: { runs: AgentRun[] }) {
  if (!runs.length) {
    return (
      <ActivityEmpty
        icon={<HistoryIcon />}
        title="No runs yet"
        body="Once an agent picks up this card, its runs will appear here with summaries and timeline."
      />
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-10 grid grid-cols-[120px_120px_72px_88px_88px_72px_64px_minmax(0,1fr)_24px] items-center gap-3 border-b border-border bg-surface-2 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-mute md:px-5">
        <span>Agent</span>
        <span>Status</span>
        <span>Card</span>
        <span>Started</span>
        <span>Duration</span>
        <span className="text-right">Tokens</span>
        <span className="text-right">Events</span>
        <span>Moved to</span>
        <span />
      </div>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
    </div>
  );
}

function RunRow({ run }: { run: AgentRun }) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const lastEvents = run.events.slice(-8);
  const summarySource = run.summary || run.error;
  const summaryParsed = summarySource ? tryParseJson(summarySource) : null;

  async function loadDiff() {
    setDiffLoading(true);
    setDiffError(null);
    try {
      setDiff(await apiJson<WorkspaceDiff>(`/api/orchestrator/runs/${run.id}/diff`));
    } catch (caught) {
      setDiffError(errorMessage(caught));
    } finally {
      setDiffLoading(false);
    }
  }

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="grid w-full grid-cols-[120px_120px_72px_88px_88px_72px_64px_minmax(0,1fr)_24px] items-center gap-3 bg-surface px-3 py-2 text-left transition hover:bg-surface-2 md:px-5"
      >
        <span className="truncate font-mono text-[11px] font-medium text-ink-2">
          {run.agent_id}
        </span>
        <span className="min-w-0">
          <StatusPill status={run.status} />
        </span>
        <span className="truncate font-mono text-[10.5px] uppercase tracking-wider text-mute">
          {run.identifier}
        </span>
        <span
          className="font-mono text-[11px] tabular-nums text-mute"
          title={new Date(run.started_at).toLocaleString()}
        >
          {new Date(run.started_at).toLocaleTimeString()}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-ink-2">
          {run.runtime_ms ? formatDuration(run.runtime_ms) : "—"}
        </span>
        <span className="text-right font-mono text-[11px] tabular-nums text-ink-2">
          {formatNumber(run.total_tokens)}
        </span>
        <span className="text-right font-mono text-[11px] tabular-nums text-ink-2">
          {run.events.length}
        </span>
        <span className="truncate font-mono text-[11px] text-ink-2">
          {run.moved_to_state ? (
            <span className="flex items-center gap-1">
              <span className="text-mute-2" aria-hidden>
                →
              </span>
              {run.moved_to_state}
            </span>
          ) : (
            <span className="text-mute-2">—</span>
          )}
        </span>
        <span
          className={`flex justify-end text-mute-2 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <ChevronRight />
        </span>
      </button>
      {expanded ? (
        <div className="grid gap-3 border-t border-border bg-surface-2 px-3 py-3 md:grid-cols-[1.1fr_0.9fr_1.2fr] md:px-5">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-mute-2">
              Summary
            </div>
            {!summarySource ? (
              <p className="text-[12px] italic text-mute">No summary captured.</p>
            ) : summaryParsed ? (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface px-2 py-1.5 font-mono text-[10.5px] leading-snug text-ink-3 scrollbar-thin">
                {compactJson(summaryParsed)}
              </pre>
            ) : (
              <p className="whitespace-pre-wrap text-[12px] leading-snug text-ink-2">
                {summarySource}
              </p>
            )}
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-mute-2">
              Timeline (last {lastEvents.length})
            </div>
            {lastEvents.length ? (
              <ol className="max-h-40 space-y-1 overflow-auto rounded-md bg-surface px-2 py-1.5">
                {lastEvents.map((event) => (
                  <li
                    key={event.id}
                    className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 font-mono text-[10.5px]"
                  >
                    <span className="tabular-nums text-mute-2">
                      {new Date(event.created_at).toLocaleTimeString()}
                    </span>
                    <span className="truncate text-ink-3">
                      <span className="font-medium text-data">{event.event_type}</span>
                      {event.message ? <span className="text-mute"> · {event.message}</span> : ""}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[12px] italic text-mute">No events recorded.</p>
            )}
          </div>
          <RunDiffPanel
            run={run}
            diff={diff}
            loading={diffLoading}
            error={diffError}
            onLoad={() => void loadDiff()}
          />
        </div>
      ) : null}
    </div>
  );
}

function RunDiffPanel({
  run,
  diff,
  loading,
  error,
  onLoad,
}: {
  run: AgentRun;
  diff: WorkspaceDiff | null;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
}) {
  return (
    <RunChangeViewer
      run={run}
      diff={diff}
      loading={loading}
      error={error}
      onLoad={onLoad}
      compact
    />
  );
}

function RunChangeViewer({
  run,
  diff,
  loading,
  error,
  onLoad,
  showChangesOnly = true,
  onShowChangesOnlyChange,
  compact,
}: {
  run: Pick<AgentRun, "id" | "identifier" | "workspace_path"> | null;
  diff: WorkspaceDiff | null;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
  showChangesOnly?: boolean;
  onShowChangesOnlyChange?: (value: boolean) => void;
  compact?: boolean;
}) {
  const { resolvedTheme } = useThemePreference();
  const treeFiles = useMemo(
    () => (diff ? filesForTree(diff, showChangesOnly) : []),
    [diff, showChangesOnly],
  );
  const totalFileCount = diff?.all_files.length ?? 0;
  const changedFileCount = diff?.files.length ?? 0;

  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-mute-2">
            File explorer
          </div>
          {diff?.available ? (
            <div className="font-mono text-[10.5px] text-mute">
              {changedFileCount} changed / {totalFileCount} files
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {diff?.available && onShowChangesOnlyChange ? (
            <label className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-[11px] text-ink-3">
              <input
                type="checkbox"
                checked={showChangesOnly}
                onChange={(event) => onShowChangesOnlyChange(event.target.checked)}
              />
              changes only
            </label>
          ) : null}
          {diff ? (
            <button
              type="button"
              className="btn-ghost h-7 px-2 text-[11px]"
              onClick={onLoad}
              disabled={loading || !run?.workspace_path}
            >
              {loading ? "Refreshing" : "Refresh"}
            </button>
          ) : null}
        </div>
      </div>
      {!run ? (
        <p className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] italic text-mute">
          No run is available for this worktree yet.
        </p>
      ) : !run.workspace_path ? (
        <p className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] italic text-mute">
          No workspace path recorded.
        </p>
      ) : error ? (
        <p className="rounded-md border border-err/30 bg-err-soft px-2 py-1.5 text-[12px] text-err">
          {error}
        </p>
      ) : !diff ? (
        <div className="rounded-md border border-dashed border-border bg-surface px-2 py-2 text-[12px] text-mute">
          {loading ? "Loading file tree and diff..." : `Preparing file tree for ${run.identifier}.`}
        </div>
      ) : !diff.available ? (
        <div className="rounded-md border border-border bg-surface px-3 py-2">
          <p className="text-[12px] text-mute">{diff.error ?? "No diff available."}</p>
          {diff.error === "Workspace no longer exists." ? (
            <p className="mt-1 text-[11px] text-mute-2">
              This run points at an old workspace that was removed before workspace retention was
              enabled. New runs will keep their worktree for browsing.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="min-w-0 overflow-hidden rounded-md border border-border bg-surface">
          <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-2 px-2 py-1.5">
            <span className="font-mono text-[10.5px] text-mute">
              {showChangesOnly ? `${changedFileCount} changed` : `${totalFileCount} files`}
            </span>
            <span
              className="truncate font-mono text-[10px] text-mute-2"
              title={diff.workspace_path ?? ""}
            >
              {diff.workspace_path}
            </span>
          </div>
          {treeFiles.length ? (
            <ChangedFileTree files={treeFiles} compact={compact} />
          ) : (
            <p className="border-b border-border px-2 py-1.5 text-[12px] italic text-mute">
              No files to show.
            </p>
          )}
          {diff.stat ? (
            <pre className="max-h-20 overflow-auto border-b border-border px-2 py-1.5 font-mono text-[10.5px] leading-snug text-ink-3">
              {diff.stat}
            </pre>
          ) : null}
          {diff.patch ? (
            <div className={`${compact ? "max-h-56" : "max-h-[34rem]"} overflow-auto bg-surface`}>
              <PatchDiff
                patch={diff.patch}
                disableWorkerPool
                options={{
                  diffStyle: "unified",
                  hunkSeparators: "line-info-basic",
                  overflow: "wrap",
                  themeType: resolvedTheme,
                  disableLineNumbers: compact,
                }}
              />
            </div>
          ) : (
            <p className="px-2 py-1.5 text-[12px] italic text-mute">
              No tracked patch. Untracked files are listed above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ChangedFileTree({ files, compact }: { files: WorkspaceDiff["files"]; compact?: boolean }) {
  const paths = useMemo(
    () => files.map((file) => file.path).toSorted((a, b) => a.localeCompare(b)),
    [files],
  );
  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      files
        .filter((file) => file.status.trim())
        .map((file) => ({ path: file.path, status: toTreeGitStatus(file.status) })),
    [files],
  );
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus,
    initialExpansion: "open",
    paths,
    search: files.length > 8,
    unsafeCSS: `
      :host {
        --trees-fg-override: #18181b;
        --trees-border-color-override: #ececeb;
        --trees-selected-bg-override: #eff6ff;
        font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
      }
    `,
  });

  return (
    <div className="border-b border-border">
      <FileTree model={model} style={{ display: "block", height: compact ? "150px" : "260px" }} />
    </div>
  );
}

function runTargetForSelection(
  worktree: WorktreeGroup,
  selection: WorktreeSelection | null,
): Pick<AgentRun, "id" | "identifier" | "workspace_path"> | null {
  if (selection?.kind === "ticket" && selection.cardId) {
    return latestRunForCard(worktree, selection.cardId) ?? worktree.latestRun;
  }
  if (selection?.kind === "agent" && selection.agentId) {
    const agent = worktree.runningAgents.find((entry) => entry.agent_id === selection.agentId);
    if (agent) {
      return {
        id: agent.run_id,
        identifier: agent.issue.identifier,
        workspace_path: agent.workspace_path,
      };
    }
  }
  return worktree.latestRun;
}

function latestRunForCard(worktree: WorktreeGroup, cardId: string): AgentRun | null {
  let latest: AgentRun | null = null;
  for (const run of worktree.runs) {
    if (run.issue_id !== cardId) continue;
    if (!latest || new Date(run.started_at).getTime() > new Date(latest.started_at).getTime())
      latest = run;
  }
  return latest;
}

function filesForTree(diff: WorkspaceDiff, changesOnly: boolean): WorkspaceDiff["files"] {
  if (changesOnly) return diff.files;
  const changedStatus = new Map(diff.files.map((file) => [file.path, file.status]));
  return (diff.all_files.length ? diff.all_files : diff.files.map((file) => file.path)).map(
    (filePath) => ({
      path: filePath,
      status: changedStatus.get(filePath) ?? "",
    }),
  );
}

function buildWorktreeGroups(
  cards: Card[],
  runningAgents: RunningAgent[],
  runs: AgentRun[],
): WorktreeGroup[] {
  const groups = new Map<string, WorktreeGroup>();
  const cardsById = new Map(cards.map((card) => [card.id, card]));

  function ensure(path: string): WorktreeGroup {
    const existing = groups.get(path);
    if (existing) return existing;
    const group: WorktreeGroup = {
      path,
      workspaceKey: workspaceKeyFromPath(path),
      assignedCards: [],
      runningAgents: [],
      runs: [],
      latestRun: null,
    };
    groups.set(path, group);
    return group;
  }

  for (const agent of runningAgents) {
    if (!agent.workspace_path) continue;
    const group = ensure(agent.workspace_path);
    group.runningAgents.push(agent);
    if (!group.assignedCards.some((card) => card.id === agent.issue.id))
      group.assignedCards.push(agent.issue);
  }

  for (const run of runs) {
    if (!run.workspace_path || !run.workspace_exists) continue;
    const group = ensure(run.workspace_path);
    group.runs.push(run);
    const card = cardsById.get(run.issue_id);
    if (card && !group.assignedCards.some((assigned) => assigned.id === card.id))
      group.assignedCards.push(card);
    if (
      !group.latestRun ||
      new Date(run.started_at).getTime() > new Date(group.latestRun.started_at).getTime()
    ) {
      group.latestRun = run;
    }
  }

  for (const card of cards) {
    const assignedPath = stringExtra(card.extra_data, "assigned_workspace_path");
    if (!assignedPath) continue;
    const group = groups.get(assignedPath);
    if (!group) continue;
    group.workspaceKey =
      stringExtra(card.extra_data, "assigned_workspace_key") ?? group.workspaceKey;
    if (!group.assignedCards.some((assigned) => assigned.id === card.id))
      group.assignedCards.push(card);
  }

  return Array.from(groups.values()).toSorted((left, right) => {
    if (left.runningAgents.length !== right.runningAgents.length)
      return right.runningAgents.length - left.runningAgents.length;
    const leftTime = left.latestRun ? new Date(left.latestRun.started_at).getTime() : 0;
    const rightTime = right.latestRun ? new Date(right.latestRun.started_at).getTime() : 0;
    return rightTime - leftTime || left.path.localeCompare(right.path);
  });
}

function stringExtra(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function workspaceKeyFromPath(workspacePath: string): string | null {
  const parts = workspacePath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? null;
}

function toTreeGitStatus(status: string): GitStatus {
  const normalized = status.trim();
  if (normalized === "A") return "added";
  if (normalized === "D") return "deleted";
  if (normalized === "R") return "renamed";
  if (normalized === "??") return "untracked";
  if (normalized.includes("A")) return "added";
  if (normalized.includes("D")) return "deleted";
  if (normalized.includes("R")) return "renamed";
  if (normalized.includes("?")) return "untracked";
  return "modified";
}

function ActivityEmpty({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6 py-8">
      <div className="grid place-items-center gap-2 text-center">
        <div className="grid h-9 w-9 place-items-center rounded-full bg-bg-2 text-mute-2">
          {icon}
        </div>
        <p className="text-[12.5px] font-semibold tracking-tight text-ink-2">{title}</p>
        <p className="max-w-md text-[11.5px] leading-relaxed text-mute">{body}</p>
      </div>
    </div>
  );
}

function avatarColor(author: string): string {
  if (!author) return "#6b6b70";
  let hash = 0;
  for (let i = 0; i < author.length; i++) hash = (hash * 31 + author.charCodeAt(i)) >>> 0;
  const palette = ["#0a0a0a", "#2563eb", "#7c3aed", "#16a34a", "#b45309", "#dc2626", "#0891b2"];
  return palette[hash % palette.length] ?? palette[0]!;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

function commentKindClass(kind: CardComment["kind"]) {
  if (kind === "planning") return "border-data/20 bg-data-soft text-data";
  if (kind === "agent") return "border-info/20 bg-info-soft text-info";
  if (kind === "result") return "border-ok/20 bg-ok-soft text-ok";
  return "border-border-2 bg-bg-2 text-mute";
}

function Empty({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="grid place-items-center gap-3 px-6 py-14 text-center">
      <div className="grid h-10 w-10 place-items-center rounded-full bg-bg-2 text-mute">{icon}</div>
      <div className="space-y-1">
        <p className="text-[13.5px] font-semibold tracking-tight text-ink-2">{title}</p>
        <p className="max-w-md text-[12px] text-mute">{body}</p>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Inline icons                                                            */
/* ──────────────────────────────────────────────────────────────────────── */

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M14 14l-3-3" />
    </svg>
  );
}
function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9L14 6" />
      <path d="M14 2.5V6h-3.5" />
      <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9L2 10" />
      <path d="M2 13.5V10h3.5" />
    </svg>
  );
}
function ChevronDown() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 6l4.5 4.5L12.5 6" />
    </svg>
  );
}
function ChevronRight() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 3.5L10.5 8 6 12.5" />
    </svg>
  );
}
function CommentIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 4A1.5 1.5 0 0 1 5 2.5h7A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11h-.5A1.5 1.5 0 0 1 2 9.5V4Z" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h7A1.5 1.5 0 0 1 13 3.5v5A1.5 1.5 0 0 1 11.5 10H7l-3.5 3v-3A1.5 1.5 0 0 1 2 8.5v-5Z" />
      <path d="M5 5.5h6M5 8h3.5" />
    </svg>
  );
}
function EditIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 2.5l2.5 2.5-7.5 7.5H3.5V10L11 2.5z" />
    </svg>
  );
}
function AgentIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <path d="M9 11h.01M15 11h.01" />
      <path d="M9 15h6" />
      <path d="M12 3v3" />
    </svg>
  );
}
function RetryIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}
function HistoryIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z" />
    </svg>
  );
}
function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}
function DocIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 2.5h6l3 3v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
      <path d="M9.5 2.5v3h3" />
    </svg>
  );
}
function PropertiesIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4h10M3 8h10M3 12h6" />
    </svg>
  );
}
function PlanningIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M16 4v3h3" />
      <path d="M8 12h8M8 16h5" />
    </svg>
  );
}
function ReturnIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 4v3.5a2.5 2.5 0 0 1-2.5 2.5H3.5" />
      <path d="M6 7L3 10l3 3" />
    </svg>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                 */
/* ──────────────────────────────────────────────────────────────────────── */

function matchesLog(log: LogRecord, filters: Filters) {
  if (filters.level && log.level !== filters.level) return false;
  if (filters.event && log.event !== filters.event) return false;
  if (filters.agent && log.agent_id !== filters.agent) return false;
  if (!filters.search.trim()) return true;
  return [
    log.ts,
    log.level,
    log.event,
    log.agent_id,
    log.identifier,
    log.issue_id,
    log.title,
    log.message,
    log.error,
    log.command,
    log.workspace_path,
    log.codex_event_type,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(filters.search.toLowerCase());
}

function isSignalLog(log: LogRecord) {
  if (log.level === "error" || log.level === "warn") return true;
  if (log.event !== "codex_event") return true;
  if (log.message || log.error) return true;
  const noisyCodexEvents = new Set([
    "item.started",
    "item.completed",
    "thread.started",
    "turn.started",
    "process.started",
  ]);
  return !noisyCodexEvents.has(log.codex_event_type ?? "");
}

function logDetail(log: LogRecord) {
  if (log.event === "agent_picked_card") return `picked ${log.identifier} · ${log.title}`;
  if (log.event === "agent_launching")
    return `workspace ${log.workspace_path}\ncommand ${log.command}`;
  if (log.event === "codex_event" && log.codex_event_type)
    return log.message || log.error || log.codex_event_type;
  return log.message || log.error || log.identifier || log.issue_id || "";
}

function unique(values: string[]) {
  return [...new Set(values)].toSorted();
}

function levelClass(level: LogRecord["level"]) {
  if (level === "error") return "border border-err/20 bg-err-soft text-err";
  if (level === "warn") return "border border-warn/20 bg-warn-soft text-warn";
  if (level === "info") return "border border-info/20 bg-info-soft text-info";
  return "border border-border-2 bg-bg-2 text-mute";
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function draftFromCard(card: Card, runs: AgentRun[] = []): CardDraft {
  return {
    id: card.id,
    identifier: card.identifier,
    title: card.title,
    description: card.description ?? "",
    state: card.state,
    priority: card.priority ? String(card.priority) : "",
    labels: card.labels.join(", "),
    extraData: JSON.stringify(card.extra_data ?? {}, null, 2),
    comments: card.comments ?? [],
    newComment: "",
    newCommentKind: "planning",
    runs,
    t3Links: latestT3LinksForRuns(runs),
  };
}

function latestT3LinksForRuns(runs: AgentRun[]): CardT3Links | null {
  const latestRun = runs
    .filter((run) => run.t3_thread_id && run.t3_chat_url && run.t3_embed_url)
    .toSorted((left, right) => {
      return new Date(right.started_at).getTime() - new Date(left.started_at).getTime();
    })[0];

  if (!latestRun?.t3_thread_id || !latestRun.t3_chat_url || !latestRun.t3_embed_url) return null;

  return {
    threadId: latestRun.t3_thread_id,
    chatUrl: latestRun.t3_chat_url,
    embedUrl: latestRun.t3_embed_url,
  };
}

function parseExtraDataDraft(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { note: value };
  }
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const hint = text.trim().startsWith("<")
      ? "Received HTML instead of JSON. The Bun API server is likely stale or Vite is not proxying /api."
      : "Received a non-JSON response from the API.";
    throw new Error(`${hint} ${response.status} ${response.statusText}`.trim());
  }
  const payload = JSON.parse(text) as T | { error?: string };
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(String(error));
  }
  return payload as T;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
