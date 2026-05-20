import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentRun, AgentRunEvent, BlockerRef, Issue, IssueComment, RunStatus } from "./types";

export type CardInput = {
  title: string;
  description?: string | null;
  priority?: number | null;
  state?: string;
  labels?: string[];
  blocked_by?: BlockerRef[];
  extra_data?: Record<string, unknown>;
};

export type CommentInput = {
  author?: string;
  body: string;
  kind?: IssueComment["kind"];
};

export type AgentRunInput = {
  issue_id: string;
  identifier: string;
  agent_id: string;
  status: RunStatus;
  attempt: number | null;
  command: string;
  model: string | null;
  profile: string | null;
  workspace_path?: string | null;
  pid?: number | null;
};

export type AgentRunUpdate = Partial<{
  status: RunStatus;
  workspace_path: string | null;
  pid: number | null;
  summary: string | null;
  error: string | null;
  moved_to_state: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  runtime_ms: number;
  finished_at: string | null;
}>;

export type AgentEventInput = {
  run_id: string;
  issue_id: string;
  agent_id: string;
  level?: AgentRunEvent["level"];
  event_type: string;
  message?: string | null;
  data?: Record<string, unknown>;
};

export class KanbanStore {
  readonly db: Database;

  constructor(dbPath = ".data/kanban.sqlite") {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  listCards(): Issue[] {
    return this.hydrateRows(
      this.db.query<CardRow, []>("SELECT * FROM cards ORDER BY state, position, created_at").all(),
    );
  }

  listByStates(states: string[]): Issue[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    const rows = this.db
      .query<CardRow, string[]>(
        `SELECT * FROM cards WHERE lower(state) IN (${placeholders}) ORDER BY state, position, created_at, identifier`,
      )
      .all(...states.map((state) => state.toLowerCase()));
    return this.hydrateRows(rows);
  }

  listTerminal(states: string[]): Issue[] {
    return this.listByStates(states);
  }

  getCardsByIds(ids: string[]): Issue[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.hydrateRows(
      this.db
        .query<CardRow, string[]>(`SELECT * FROM cards WHERE id IN (${placeholders})`)
        .all(...ids),
    );
  }

  createCard(input: CardInput): Issue {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const count =
      this.db.query<{ count: number }, []>("SELECT count(*) as count FROM cards").get()?.count ?? 0;
    const identifier = `KAN-${count + 1}`;
    const state = input.state?.trim() || "Todo";
    const position = this.nextPosition(state);
    this.db
      .query(
        `INSERT INTO cards (id, identifier, title, description, priority, state, labels_json, blocked_by_json, extra_data_json, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        identifier,
        input.title,
        input.description ?? null,
        input.priority ?? null,
        state,
        JSON.stringify((input.labels ?? []).map((label) => label.toLowerCase())),
        JSON.stringify(input.blocked_by ?? []),
        JSON.stringify(input.extra_data ?? {}),
        position,
        now,
        now,
      );
    return this.getCard(id)!;
  }

  updateCard(id: string, input: Partial<CardInput>): Issue | null {
    const current = this.getCard(id);
    if (!current) return null;
    const next = {
      title: input.title ?? current.title,
      description: input.description ?? current.description,
      priority: input.priority ?? current.priority,
      state: input.state ?? current.state,
      labels: input.labels ?? current.labels,
      blocked_by: input.blocked_by ?? current.blocked_by,
      extra_data: input.extra_data ?? current.extra_data,
    };
    this.db
      .query(
        `UPDATE cards
         SET title = ?, description = ?, priority = ?, state = ?, labels_json = ?, blocked_by_json = ?, extra_data_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.title,
        next.description,
        next.priority,
        next.state,
        JSON.stringify(next.labels.map((label) => label.toLowerCase())),
        JSON.stringify(next.blocked_by),
        JSON.stringify(next.extra_data),
        new Date().toISOString(),
        id,
      );
    return this.getCard(id);
  }

  moveCard(id: string, state: string, position?: number): Issue | null {
    const card = this.getCard(id);
    if (!card) return null;
    const now = new Date().toISOString();
    const nextState = state.trim() || card.state;
    const targetRows = this.db
      .query<CardRow, [string, string]>(
        "SELECT * FROM cards WHERE state = ? AND id != ? ORDER BY position, created_at",
      )
      .all(nextState, id);
    const targetIndex =
      typeof position === "number" && Number.isFinite(position)
        ? Math.max(0, Math.min(Math.trunc(position), targetRows.length))
        : targetRows.length;
    const orderedIds = targetRows.map((row) => row.id);
    orderedIds.splice(targetIndex, 0, id);

    const updatePosition = this.db.query(
      "UPDATE cards SET state = ?, position = ?, updated_at = ? WHERE id = ?",
    );
    const applyMove = this.db.transaction(() => {
      for (const [index, orderedId] of orderedIds.entries()) {
        updatePosition.run(nextState, index + 1, now, orderedId);
      }
      if (card.state !== nextState) {
        this.rebalanceState(card.state, now);
      }
    });
    applyMove();
    return this.getCard(id);
  }

  deleteCard(id: string): boolean {
    const result = this.db.query("DELETE FROM cards WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getCard(id: string): Issue | null {
    const row = this.db.query<CardRow, [string]>("SELECT * FROM cards WHERE id = ?").get(id);
    return row ? (this.hydrateRows([row])[0] ?? null) : null;
  }

  listComments(issueId: string): IssueComment[] {
    return this.db
      .query<CommentRow, [string]>(
        "SELECT * FROM comments WHERE issue_id = ? AND kind IN ('comment', 'planning', 'agent', 'result') ORDER BY created_at ASC",
      )
      .all(issueId)
      .map(rowToComment);
  }

  addComment(issueId: string, input: CommentInput): IssueComment | null {
    if (!this.getCard(issueId)) return null;
    const now = new Date().toISOString();
    const comment: IssueComment = {
      id: crypto.randomUUID(),
      issue_id: issueId,
      author: input.author?.trim() || "user",
      body: input.body.trim(),
      kind: input.kind ?? "comment",
      created_at: now,
    };
    if (!comment.body) return null;
    this.db
      .query(
        "INSERT INTO comments (id, issue_id, author, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        comment.id,
        comment.issue_id,
        comment.author,
        comment.body,
        comment.kind,
        comment.created_at,
      );
    this.db.query("UPDATE cards SET updated_at = ? WHERE id = ?").run(now, issueId);
    return comment;
  }

  createAgentRun(input: AgentRunInput): AgentRun {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO agent_runs (
          id, issue_id, identifier, agent_id, status, attempt, command, model, profile, workspace_path, pid,
          input_tokens, output_tokens, total_tokens, runtime_ms, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?)`,
      )
      .run(
        id,
        input.issue_id,
        input.identifier,
        input.agent_id,
        input.status,
        input.attempt,
        input.command,
        input.model,
        input.profile,
        input.workspace_path ?? null,
        input.pid ?? null,
        now,
      );
    return this.getAgentRun(id)!;
  }

  updateAgentRun(id: string, update: AgentRunUpdate): AgentRun | null {
    const current = this.getAgentRun(id);
    if (!current) return null;
    const next = {
      status: update.status ?? current.status,
      workspace_path: update.workspace_path ?? current.workspace_path,
      pid: update.pid ?? current.pid,
      summary: update.summary ?? current.summary,
      error: update.error ?? current.error,
      moved_to_state: update.moved_to_state ?? current.moved_to_state,
      input_tokens: update.input_tokens ?? current.input_tokens,
      output_tokens: update.output_tokens ?? current.output_tokens,
      total_tokens: update.total_tokens ?? current.total_tokens,
      runtime_ms: update.runtime_ms ?? current.runtime_ms,
      finished_at: update.finished_at === undefined ? current.finished_at : update.finished_at,
    };
    this.db
      .query(
        `UPDATE agent_runs
         SET status = ?, workspace_path = ?, pid = ?, summary = ?, error = ?, moved_to_state = ?,
             input_tokens = ?, output_tokens = ?, total_tokens = ?, runtime_ms = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.workspace_path,
        next.pid,
        next.summary,
        next.error,
        next.moved_to_state,
        next.input_tokens,
        next.output_tokens,
        next.total_tokens,
        next.runtime_ms,
        next.finished_at,
        id,
      );
    return this.getAgentRun(id);
  }

  addAgentEvent(input: AgentEventInput): AgentRunEvent {
    const event: AgentRunEvent = {
      id: crypto.randomUUID(),
      run_id: input.run_id,
      issue_id: input.issue_id,
      agent_id: input.agent_id,
      level: input.level ?? "info",
      event_type: input.event_type,
      message: input.message ?? null,
      data: input.data ?? {},
      created_at: new Date().toISOString(),
    };
    this.db
      .query(
        "INSERT INTO agent_run_events (id, run_id, issue_id, agent_id, level, event_type, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.id,
        event.run_id,
        event.issue_id,
        event.agent_id,
        event.level,
        event.event_type,
        event.message,
        JSON.stringify(event.data),
        event.created_at,
      );
    return event;
  }

  getAgentRun(id: string): AgentRun | null {
    const row = this.db
      .query<AgentRunRow, [string]>("SELECT * FROM agent_runs WHERE id = ?")
      .get(id);
    return row ? rowToAgentRun(row, this.listAgentRunEvents(id)) : null;
  }

  listAgentRuns(issueId?: string, limit = 100): AgentRun[] {
    const rows = issueId
      ? this.db
          .query<AgentRunRow, [string, number]>(
            "SELECT * FROM agent_runs WHERE issue_id = ? ORDER BY started_at DESC LIMIT ?",
          )
          .all(issueId, limit)
      : this.db
          .query<AgentRunRow, [number]>("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?")
          .all(limit);
    const eventsByRun = new Map<string, AgentRunEvent[]>();
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const events = this.db
        .query<AgentRunEventRow, string[]>(
          `SELECT * FROM agent_run_events WHERE run_id IN (${placeholders}) ORDER BY created_at ASC`,
        )
        .all(...ids)
        .map(rowToAgentRunEvent);
      for (const event of events) {
        const bucket = eventsByRun.get(event.run_id) ?? [];
        bucket.push(event);
        eventsByRun.set(event.run_id, bucket);
      }
    }
    return rows.map((row) => rowToAgentRun(row, eventsByRun.get(row.id) ?? []));
  }

  listAgentRunEvents(runId: string): AgentRunEvent[] {
    return this.db
      .query<AgentRunEventRow, [string]>(
        "SELECT * FROM agent_run_events WHERE run_id = ? ORDER BY created_at ASC",
      )
      .all(runId)
      .map(rowToAgentRunEvent);
  }

  private nextPosition(state: string): number {
    return (
      (this.db
        .query<{ max_position: number | null }, [string]>(
          "SELECT max(position) as max_position FROM cards WHERE state = ?",
        )
        .get(state)?.max_position ?? 0) + 1
    );
  }

  private rebalanceState(state: string, updatedAt: string) {
    const rows = this.db
      .query<CardRow, [string]>("SELECT * FROM cards WHERE state = ? ORDER BY position, created_at")
      .all(state);
    const updatePosition = this.db.query(
      "UPDATE cards SET position = ?, updated_at = ? WHERE id = ?",
    );
    for (const [index, row] of rows.entries()) {
      updatePosition.run(index + 1, updatedAt, row.id);
    }
  }

  private migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT,
        priority INTEGER,
        state TEXT NOT NULL,
        branch_name TEXT,
        url TEXT,
        labels_json TEXT NOT NULL DEFAULT '[]',
        blocked_by_json TEXT NOT NULL DEFAULT '[]',
        extra_data_json TEXT NOT NULL DEFAULT '{}',
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.ensureColumn("cards", "extra_data_json", "TEXT NOT NULL DEFAULT '{}'");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'comment',
        created_at TEXT NOT NULL
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS comments_issue_id_created_at_idx ON comments(issue_id, created_at)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        identifier TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER,
        command TEXT NOT NULL,
        model TEXT,
        profile TEXT,
        workspace_path TEXT,
        pid INTEGER,
        summary TEXT,
        error TEXT,
        moved_to_state TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        runtime_ms INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS agent_runs_issue_started_idx ON agent_runs(issue_id, started_at)",
    );
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        issue_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        level TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT,
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS agent_run_events_run_created_idx ON agent_run_events(run_id, created_at)",
    );
  }

  private hydrateRows(rows: CardRow[]): Issue[] {
    const commentsByIssue = new Map<string, IssueComment[]>();
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const comments = this.db
        .query<CommentRow, string[]>(
          `SELECT * FROM comments WHERE issue_id IN (${placeholders}) AND kind IN ('comment', 'planning', 'agent', 'result') ORDER BY created_at ASC`,
        )
        .all(...ids)
        .map(rowToComment);
      for (const comment of comments) {
        const bucket = commentsByIssue.get(comment.issue_id) ?? [];
        bucket.push(comment);
        commentsByIssue.set(comment.issue_id, bucket);
      }
    }
    return rows.map((row) => rowToIssue(row, commentsByIssue.get(row.id) ?? []));
  }

  private ensureColumn(table: string, column: string, ddl: string) {
    const rows = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
    if (!rows.some((row) => row.name === column)) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }
}

type CardRow = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  position: number;
  branch_name: string | null;
  url: string | null;
  labels_json: string;
  blocked_by_json: string;
  extra_data_json: string;
  created_at: string;
  updated_at: string;
};

type CommentRow = {
  id: string;
  issue_id: string;
  author: string;
  body: string;
  kind: string;
  created_at: string;
};

type AgentRunRow = {
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
};

type AgentRunEventRow = {
  id: string;
  run_id: string;
  issue_id: string;
  agent_id: string;
  level: string;
  event_type: string;
  message: string | null;
  data_json: string;
  created_at: string;
};

function rowToIssue(row: CardRow, comments: IssueComment[]): Issue {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    priority: row.priority,
    state: row.state,
    position: row.position,
    branch_name: row.branch_name,
    url: row.url,
    labels: parseJson(row.labels_json, []),
    blocked_by: parseJson(row.blocked_by_json, []),
    comments,
    comment_count: comments.length,
    extra_data: parseJson(row.extra_data_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToComment(row: CommentRow): IssueComment {
  return {
    id: row.id,
    issue_id: row.issue_id,
    author: row.author,
    body: row.body,
    kind: isCommentKind(row.kind) ? row.kind : "comment",
    created_at: row.created_at,
  };
}

function isCommentKind(kind: string): kind is IssueComment["kind"] {
  return ["comment", "planning", "agent", "result"].includes(kind);
}

function rowToAgentRun(row: AgentRunRow, events: AgentRunEvent[]): AgentRun {
  return {
    id: row.id,
    issue_id: row.issue_id,
    identifier: row.identifier,
    agent_id: row.agent_id,
    status: isRunStatus(row.status) ? row.status : "Failed",
    attempt: row.attempt,
    command: row.command,
    model: row.model,
    profile: row.profile,
    workspace_path: row.workspace_path,
    workspace_exists: row.workspace_path ? existsSync(row.workspace_path) : false,
    pid: row.pid,
    summary: row.summary,
    error: row.error,
    moved_to_state: row.moved_to_state,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: row.total_tokens,
    runtime_ms: row.runtime_ms,
    started_at: row.started_at,
    finished_at: row.finished_at,
    events,
  };
}

function rowToAgentRunEvent(row: AgentRunEventRow): AgentRunEvent {
  return {
    id: row.id,
    run_id: row.run_id,
    issue_id: row.issue_id,
    agent_id: row.agent_id,
    level: isEventLevel(row.level) ? row.level : "info",
    event_type: row.event_type,
    message: row.message,
    data: parseJson(row.data_json, {}),
    created_at: row.created_at,
  };
}

function isEventLevel(level: string): level is AgentRunEvent["level"] {
  return ["debug", "info", "warn", "error"].includes(level);
}

function isRunStatus(status: string): status is RunStatus {
  return [
    "PreparingWorkspace",
    "BuildingPrompt",
    "LaunchingAgentProcess",
    "StreamingTurn",
    "Finishing",
    "Succeeded",
    "Failed",
    "TimedOut",
    "Stalled",
    "CanceledByReconciliation",
  ].includes(status);
}

function parseJson<T>(source: string, fallback: T): T {
  try {
    return JSON.parse(source) as T;
  } catch {
    return fallback;
  }
}
