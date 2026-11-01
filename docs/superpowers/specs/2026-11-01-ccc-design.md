# Claude Command Center (CCC) — design

Date: 2026-11-01 · Owner: Ahmed Shaltoot · Repo: `shaltut/ccc` (private)

## 1. Intent

Ahmed runs about ten Claude Code sessions at once (an Orchestrator, numbered workers W1…Wn, a Helper,
an Auditor, test-cycle builders) across a **Windows box, a Mac and a VPS**. Today the coordination
lives in places that break:

- Owner Q&A runs on claude.ai Artifact pages. Those pages hit a **200 publishes/day cap**, and an
  **account switch** (done to work around usage limits) locks the owner out of pages the other
  account created.
- `SendMessage` / `ListAgents` only reach sessions on the same machine.
- Standing rules such as "ping any session idle for over 1 hour" live in a session-local cron, which
  is **lost when that session restarts**.

CCC is one small self-hosted service that holds this coordination state **independent of any Claude
account**:

- Every session reports **what it is working on, its status, blockers, questions and answers**.
- The **Orchestrator directs** everyone through an **inbox model**: it sends tasks and instructions,
  and sessions pick them up.
- **Agents talk to CCC through an API, an MCP endpoint and a CLI**, never the UI.
- **Ahmed gets a UI**: a live board, a question queue he can answer from his phone, and controls.

It is a side tool to help finish the iHop project. iHop workers **will** post through it.

## 2. Goals

1. One place showing every session: name, role, device, status, current task, blocker, last seen,
   unread count.
2. Messages get delivered across machines and survive restarts and account switches. A relaunched
   session with the same name picks up its identity, open tasks and unread inbox.
3. The Orchestrator can do everything over API/MCP: assign, reassign, cancel, instruct, broadcast,
   pause/resume one session or all, change roles.
4. Questions are first-class: asked by any session, addressed to the owner or the Orchestrator,
   optionally with choices, answered in the UI (or by the Orchestrator over API), and the answer is
   delivered to the asker's inbox.
5. Status reporting happens automatically through Claude Code hooks, so a session that forgets to
   report still shows its real state.
6. Server-side watchdogs (idle ping, offline detection) that keep running whatever any session does.
7. Ships as one standard Docker image plus Postgres.

## 3. Non-goals (v1)

- **Process control.** CCC never starts, stops or kills Claude processes. "Control" means inbox
  instructions that sessions obey.
- **Deployment, hosting, domain, TLS, backups.** Ahmed's VM agent owns these. CCC ships an image, a
  sample `compose.yml` and a list of env vars.
- **Redaction or anonymisation.** Owner decision 2026-11-01: iHop content, including claim
  references, may be posted as-is. No PHI filter in v1.
- Multi-user accounts, teams, permissions beyond what is below.
- Push notifications (Telegram etc.). The UI is phone-friendly. Notifications can come later.
- File attachments. Message bodies are Markdown text.
- Migrating the existing Artifact pages or memory notes.

## 4. Anti-goals (failure even if it "works")

- **CCC must never get in an agent's way.** Every hook and CLI call fails open: short timeout (about
  2 s), no error output into the session, never blocks a turn because CCC is down. Agents must
  not end up babysitting CCC.
- Hooks must not spam: no heartbeat on every tool call, no repeated blocking of the same message.
- No state tied to a Claude account, a claude.ai artifact or a single machine.
- Agents must not need the UI for anything.

## 5. Decided (by Ahmed)

| Decision | Value |
|---|---|
| Control model | Inbox: sessions pick up instructions; no remote process control |
| Devices | Windows, macOS, Linux VPS |
| Storage | **PostgreSQL** |
| Interfaces | REST API, MCP endpoint, UI for the owner |
| Packaging | Standard Docker image; Ahmed's VM agent deploys it |
| iHop traffic | Allowed; no redaction/anonymisation now |
| Delivery timing | Messages, including pause/resume, reach a session **only when its turn ends** (or through `ccc wait` / on demand). No mid-turn injection; PostToolUse stays write-only |

## 6. Builder's design (Claude's calls, overridable)

### 6.1 Stack

- TypeScript on Node 22, one process that serves the API, `/mcp` and the UI.
- Suggested libraries: Hono (HTTP), `postgres` (postgres.js) with plain SQL migrations, Zod for
  every input, `@modelcontextprotocol/sdk` (streamable HTTP transport).
- UI: static HTML + vanilla JS modules served by the same process, live updates over SSE. No
  frontend build step.
- Tests: `node:test` against a real Postgres.
- The builder may swap a library if it is clearly worse in practice. It must not add a frontend
  framework or an ORM without a reason.

### 6.2 Identity and auth

- **Device tokens.** The owner creates them in the UI, one per machine (`windows`, `mac`, `vps`).
  They are stored hashed (sha256) and shown once. The token value can be revoked.
- **Session = a stable name** (`orchestrator`, `W1`, `helper`, `auditor`…), set per launch through the env var
  `CCC_SESSION`. The name, not the Claude session id, is the identity. A new Claude process (new
  account, new machine) that uses the same name **reattaches**. The latest Claude session id, device
  and cwd are recorded on the session.
- **Two live processes with one name** (Claude's call). This happens with an account switch while the
  old process is still open, a nested `claude -p` that inherits the env, or a launch mistake.
  SessionStart compares the incoming `claude_session_id` with the holder's:
  - If the holder showed activity in the last 2 min, the newcomer is registered as `<name>-2`
    (then `-3`…), and its resume context says so plainly.
  - Otherwise the **newest process takes the name**. Hook calls carrying a stale
    `claude_session_id` get a one-time "superseded: stop working" reply and are otherwise ignored.
    In particular, a stale SessionEnd never marks the live holder offline.
- **Roles:** `orchestrator`, `worker`, `helper`, `auditor`, `other`. The role belongs to the
  session *name* and is set by the owner in the UI. New names default to `worker`; an optional
  `CCC_ROLE` env var can request any role except `orchestrator` on first registration. At most
  **one** name holds `orchestrator`, and only the owner can grant or move it. Whoever runs as that
  name has the role (see 8, accepted risk).
- **`orchestrator` is also an address alias.** A message or question sent `to: "orchestrator"`
  resolves to the current role holder. Open questions addressed to the role follow it when the
  owner moves the role.
- **Permissions:**
  - Any session can: report status, send messages to any session, ask questions, answer questions
    addressed to it, update its own tasks.
  - Orchestrator (and owner) can also: create, assign, reassign and cancel tasks; send control
    instructions (pause/resume/stop-work); broadcast; answer any question.
  - Owner (UI) can do all of the above plus manage tokens, roles and retire sessions.
- **UI login:** a single admin password from `CCC_ADMIN_PASSWORD`, compared in constant time,
  with a session cookie (HttpOnly, Secure, SameSite=Strict) and a login rate limit.
- **Attribution over MCP:** every MCP call must be attributed to a session name without the agent
  retyping it each time. Preferred: an `X-CCC-Session` header filled from `${CCC_SESSION}` in the
  MCP config. **The builder must verify** that Claude Code expands env vars in MCP `headers` for
  user-scoped config on all three OSes. If it does not, fall back to a required `session` argument
  on every tool, with a clear error when it is missing.

### 6.3 Data model (Postgres, schema `ccc`)

- `devices` — id, label, token_hash, created_at, revoked_at.
- `sessions` — id, name (unique), role, device_id, claude_session_id, cwd, project, branch,
  status, working_on (text), blocker (text, nullable), last_heartbeat_at, last_activity_at,
  paused (bool), retired_at, created_at.
  - Status values: `working`, `idle` (turn ended), `waiting_permission`, `blocked`, `paused`,
    `unreachable`, `offline`. Also stored: `last_wait_at` and `superseded_claude_session_ids`.
- `tasks` — id, title, body, assignee_session_id, created_by, status (`open`, `in_progress`,
  `blocked`, `done`, `cancelled`), blocker, result, created_at, updated_at.
- `questions` — id, asked_by, addressed_to (`owner` | session name), body, context, options
  (jsonb array of `{key,label}`, optional), is_blocking (bool), status (`open`, `answered`,
  `withdrawn`), answer_choice, answer_text, answered_by, answered_at, created_at.
- `messages` — id, from (session name or `owner` or `system`), to_session_id (null =
  broadcast), kind (`instruction`, `task`, `answer`, `control`, `note`, `ping`), body, ref_task_id,
  ref_question_id, created_at, delivered_at, read_at.
- `events` — append-only log: id, session_id, actor, type, payload jsonb, created_at. Every write
  above also writes an event. The board's timeline and the SSE stream read from here.

**Single delivery path:** anything a session must act on becomes a `messages` row addressed to it,
and its **inbox = its unread messages** (plus broadcasts after its creation). That includes a task
assignment (`kind=task`), an answer to its question (`kind=answer`) and a pause (`kind=control`).

### 6.4 Delivery to sessions (the inbox)

A Claude session only acts during a turn, so mail must reach it in three ways:

1. **Stop hook.** At the end of each turn, if undelivered messages exist, the hook returns
   `decision: block` with the messages as the reason, so the session keeps working on them. Each
   message is blocked on at most once (marked `delivered_at`). The hook respects `stop_hook_active`.
2. **`ccc wait`.** A long-poll CLI command that agents run in the background when idle. It exits
   and prints the messages when mail arrives, which re-invokes the session. The SessionStart output
   tells agents to keep one running while idle.
3. **On demand:** `ccc inbox` / MCP `get_inbox`.

Nothing is injected mid-turn (owner decision). A pause sent during a long turn lands when that
turn ends, and the board shows it as "pause pending" until then.

Reading marks messages `read_at`. There are only two controls (Claude's call; no `stop_work`):
- **pause**: "PAUSE: finish the current step, then stop and wait for RESUME." It sets `paused` and
  touches no tasks.
- **resume**: clears `paused`.

To take work away from a session, the Orchestrator reassigns or cancels the task.

### 6.5 Hooks (installed into `~/.claude/settings.json` on each machine)

The commands call `node <path>/ccc.mjs hook <event>` directly. Do **not** use `.sh` wrappers: on
Windows they open a visible git-bash window per event. Each hook reads Claude's hook JSON from
stdin, does nothing when `CCC_SESSION` is unset, and fails open.

| Hook | Effect |
|---|---|
| SessionStart | Register/reattach; stdout = resume context (identity, role, open tasks, unread inbox, last status, standing rules) |
| PostToolUse | Heartbeat `working`, throttled to at most once per 60 s (local timestamp file) |
| Notification | Status `waiting_permission` with the notification text (shows the owner who is stuck on a prompt) |
| Stop | Status `idle`; inbox delivery as in 6.4 |
| SessionEnd | Status `offline` |

### 6.6 MCP tools (all also exposed as REST endpoints)

- Everyone: `whoami` / `resume`, `report_status(working_on, status?, blocker?)`, `get_inbox`,
  `send_message(to, body)`, `ask_question(to, body, options?, is_blocking?)`,
  `answer_question(id, choice?, text)`, `list_sessions`, `list_tasks(filter)`,
  `update_task(id, status, result?, blocker?)`.
- Orchestrator/owner: `assign_task(to, title, body)`, `reassign_task`, `cancel_task`,
  `broadcast(body)`, `control(session|all, pause|resume)`, `list_questions(filter)`.

### 6.7 CLI (`ccc.mjs`)

A single file with zero dependencies (Node ≥ 18, global `fetch`), served by the server at
`/cli/ccc.mjs`. Config comes from env: `CCC_URL`, `CCC_TOKEN`, `CCC_SESSION`. Subcommands mirror
the MCP tools, plus `wait`, `hook <event>` and `install-hooks` (merges the hook entries into
`~/.claude/settings.json` without clobbering existing hooks; prints a diff and asks first).

### 6.8 Watchdogs (server, every minute)

- **Heartbeat vs activity.** A running `ccc wait` counts as a heartbeat (the session is reachable)
  but not as activity. Hooks and tool calls count as both.
- No heartbeat for **15 min**, with no SessionEnd → `unreachable`: the process may be alive, but
  nothing can wake it. The board shows this distinctly ("needs a nudge in its terminal"), and the
  Orchestrator gets an event. After SessionEnd → `offline`.
- Session not offline, not paused, no activity for **60 min** → system `ping` message to it
  ("status? what are you waiting on?"), plus an event visible to the Orchestrator. This includes
  sessions that are only waiting (the owner's standing rule). Repeat at most once per hour. For an
  unreachable session the ping waits in its inbox, and the board flag is what reaches a human.
  This replaces the session-local idle-ping cron.
- Open **blocking** question older than 30 min → highlighted at the top of the owner queue.

### 6.9 UI (owner)

Phone-friendly, one page with tabs. Live over SSE.

- **Board:** one card per session (name, role, device, status colour, working on, blocker, task,
  last seen, unread). Click → timeline of that session's events and messages, plus a send box.
- **Questions:** open first (blocking on top), choice buttons, a free-text answer, answered
  history.
- **Tasks:** list grouped by status; create, assign, reassign, cancel.
- **Controls:** broadcast, pause all / resume all, per-session pause/resume, move the Orchestrator
  role, retire a session, manage device tokens.

### 6.10 Packaging

- Multi-stage `Dockerfile` (node:22-alpine, non-root, `HEALTHCHECK` on `/healthz`). Migrations
  run on boot.
- Env: `DATABASE_URL`, `CCC_ADMIN_PASSWORD`, `CCC_PUBLIC_URL`, `PORT` (default 8080).
- A sample `compose.yml` (app + postgres + volume) for Ahmed's VM agent. A GitHub Actions
  workflow pushes `ghcr.io/shaltut/ccc` on `main` (Claude's call; drop it if the VM agent builds
  from source).
- README: env vars, how to create a device token, the per-machine setup (MCP add command, CLI
  download, `install-hooks`), and how to launch a named session on Windows, macOS and Linux.

## 7. Left to the builder

Library versions, file layout, exact SQL and indexes, REST paths, SSE event shape, UI styling, test
layout, and the wording of the SessionStart resume context (it must be short).

## 8. Risks noted

- Owner-accepted (2026-11-01): iHop content, including claim-level detail, lands on a personal VM
  with no redaction.
- The service is internet-exposed with one admin password and device tokens. TLS is handled by
  the VM agent and is mandatory.
- Spoofing between Ahmed's own sessions is possible: any valid device token can run as any name,
  including the one holding `orchestrator`. This is accepted for a single-owner tool where every
  device is his. A revoked token stops all of that device's sessions.
