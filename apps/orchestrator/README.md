# Kanban Symphony

A Bun implementation of the Symphony orchestration model using a local Kanban board instead of Linear.

The service:

- serves a usable Kanban board
- uses a React + Tailwind frontend
- stores cards in SQLite
- polls active cards and dispatches bounded Codex runs
- creates deterministic per-card workspaces
- creates Git worktrees per card when `workspace.seed_from` is a Git repository
- falls back to copying files for non-Git sources
- loads policy, hooks, concurrency, and prompt templates from `WORKFLOW.md`
- emits structured JSON logs

## Run

```bash
bun install
bun run start
```

Open `http://localhost:3000`.

## Develop

```bash
bun run dev
```

Open `http://localhost:5173` for the Vite dev server with React HMR. API requests to `/api` are proxied to the Bun server on `http://localhost:3001`.

The dev ports can be changed when the defaults are busy:

```bash
API_PORT=3101 UI_PORT=5174 bun run dev
```

## Workflow

`WORKFLOW.md` is reloaded while the service runs. The implementation supports the core Symphony fields and adds `tracker.kind: kanban`.

This implementation uses T3 Code as its agent plane while keeping this Bun server and Kanban UI as the control plane. It preserves Symphony's orchestration boundary: this app schedules cards, creates per-card workspaces, renders prompts, tracks retries/state, and asks T3 to run the actual agent turn. Provider-specific execution, including Pi, belongs behind T3.

Start or reuse a T3 Code server, issue an owner bearer token, and expose it to this process:

```bash
T3CODE_PORT=3002 t3 serve --port 3002 --no-browser
T3CODE_AUTH_TOKEN=$(t3 auth session issue --role owner --token-only)
```

When the T3 server is running in dev mode with a Vite `dev-url`, issue the bearer token against
that same dev URL so it uses the server's dev auth store:

```bash
T3CODE_AUTH_TOKEN=$(t3 auth session issue --role owner --dev-url http://localhost:5733 --token-only)
```

Configure the agent plane in `WORKFLOW.md`:

```yaml
agent_plane:
  kind: t3
  base_url: $T3CODE_BASE_URL
  auth_token_env: T3CODE_AUTH_TOKEN
  provider_instance: codex
  project_id: "" # optional; when empty, orchestration creates/selects per-card workspace projects
  model: gpt-5.5
  runtime_mode: full-access
  interaction_mode: default
```

Realtime clients can connect to `ws://localhost:3000/ws`. Server messages use `type: "run.event"` and include run metadata plus the full stored run event under `event`; T3 snapshots/events are stored under `event.data.provider_event`. Planner turns also use T3 when `planner.command: t3`, emitting `planner.event` and `planner.done` with the final session. Client controls currently include `run.cancel`, `workspace.file.read`, and `workspace.tree`.

The older local subprocess/Pi SDK runner is still available as a legacy fallback by setting `agent_plane.kind: legacy`:

```yaml
codex:
  backend: cli
  command: codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -
  output_format: codex-json
```

Set `agent_plane.provider_instance` to an instance configured in the running T3 server. The default local dev server exposes `codex`; Pi can be used here after adding it as a T3 provider instance. `agent_plane.project_id` can be selected from the orchestration UI project dropdown; leaving it empty keeps the automatic per-card workspace project behavior.

For direct Pi SDK legacy mode, set `agent_plane.kind: legacy`, `codex.backend: pi-sdk`, and `codex.command: pi-sdk`. For a Pi CLI subprocess instead of SDK embedding, use `backend: cli`, `command: PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 pi --mode json --no-session`, and `output_format: pi-json`.

Workspace creation is controlled by:

```yaml
workspace:
  root: ./workspaces
  seed_from: .
  mode: auto
```

`auto` creates a Git worktree when `seed_from` is a Git working tree and otherwise uses a copied workspace. Use `mode: git_worktree` to require worktrees, or `mode: copy` to keep the older copy behavior. Run rows include a workspace diff viewer for Git-backed workspaces.

This repository's default workflow trusts the copied workspace `.mise.toml` in `hooks.before_run` so provider processes launched by T3 can resolve the same Node/Bun toolchain inside per-card workspaces.

Ticket planning uses a separate `TICKET_CREATION_WORKFLOW.MD`, so the planning chat can have its own prompt, command, model, and reasoning level:

```yaml
planner:
  command: t3
  model: gpt-5.5
  reasoning_effort: high
  timeout_ms: 45000
```

Environment overrides are also supported: `TICKET_CREATION_WORKFLOW`, `PLANNER_AGENT_COMMAND`, `PLANNER_AGENT_MODEL`, `PLANNER_AGENT_REASONING_EFFORT`, `PLANNER_AGENT_TIMEOUT_MS`, and `PLANNER_AGENT_DISABLED=1`.

## Default States

Active: `Todo`, `In Progress`

Terminal: `Done`, `Closed`, `Cancelled`, `Canceled`, `Duplicate`

Cards in `Todo` are skipped if they have blockers whose states are not terminal.
