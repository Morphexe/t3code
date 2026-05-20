---
tracker:
  kind: kanban
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
  done_state: Done
  state_transitions:
    todo: Review
    in progress: Review
polling:
  interval_ms: 30000
workspace:
  root: ./workspaces
  seed_from: .
  mode: auto
hooks:
  before_run: test ! -f .mise.toml || mise trust .mise.toml
  timeout_ms: 60000
agent:
  max_concurrent_agents: 5
  max_turns: 1
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    todo: 1
    in progress: 2
agent_plane:
  kind: t3
  base_url: $T3CODE_BASE_URL
  auth_token_env: T3CODE_AUTH_TOKEN
  provider_instance: codex
  model: gpt-5.5
  runtime_mode: full-access
  interaction_mode: default
  poll_interval_ms: 1000
  project_id: 5089eadd-a9b0-472d-8b3b-32914dcf3af1
codex:
  backend: cli
  command: t3
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

You are working on a Kanban card from the local Symphony board.

Card: {{ issue.identifier }} - {{ issue.title }}
State: {{ issue.state }}
Priority: {{ issue.priority }}
Labels: {{ issue.labels }}
Extra data: {{ issue.extra_data }}

Description:
{{ issue.description }}

Comments and planning notes:
{{ issue.comments }}

Use the workspace as the root for this card. Make focused changes and run relevant validation.

At the end of the run, post a concise human-facing final report. Keep it succinct and include:

- What changed: one or two sentences.
- Files changed: bullet list of the important paths and why they changed.
- Validation: commands/tests/checks you ran and whether they passed.
- Remaining notes: blockers, skipped validation, or follow-up only when relevant.
