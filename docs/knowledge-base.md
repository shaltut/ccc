# CCC knowledge base

This is how CCC works and why. It is for anyone changing the code or running it. The design authority is the spec, [`superpowers/specs/2026-11-01-ccc-design.md`](superpowers/specs/2026-11-01-ccc-design.md). This page describes what was actually built.

## 1. Mental model

```
 Claude Code session (any machine)            CCC server (one container)              Owner
 ─────────────────────────────────            ──────────────────────────              ─────
 hooks  ── node ~/.ccc/ccc.mjs hook … ──▶  REST /api/*  ─┐                        browser UI
 Bash   ── node ~/.ccc/ccc.mjs wait   ──▶  long-poll     ├─▶ Postgres schema ccc ◀── /api/* (cookie)
 MCP    ── /mcp (headersHelper)       ──▶  MCP tools    ─┘   + in-process bus  ──▶ /api/stream (SSE)
```

- **CCC is an inbox and a board.** It never starts, stops or types into a process. Everything reaches an agent as a message it reads at a safe point.
- **A session is a name you choose** (`orch`, `W1`, `auditor`). It is not tied to a Claude account or a process. When an account hits its limit, start Claude again with the same `CCC_SESSION`: the board, tasks and inbox carry over.
- **Three kinds of caller:**
  - **Owner:** the UI, signed in with the admin cookie.
  - **Agents:** a device bearer token plus `X-CCC-Session`.
  - **Server:** the watchdog, which writes as `system`.

## 2. Identity

| Thing | How it's identified | Where |
|---|---|---|
| Owner | HMAC-signed cookie `ccc_admin`, 30 days; key = sha256(`ccc-cookie:` + password) | `src/auth.ts` |
| Device (a machine) | Bearer token `ccc_…` (32 random bytes), stored only as a sha256 hash; revocable | `src/auth.ts` |
| Session (a name) | `X-CCC-Session` header, from the `CCC_SESSION` env var | `src/actor.ts` |
| Claude process | `X-CCC-Claude-Session`: hooks send stdin `session_id`; the CLI sends `CLAUDE_CODE_SESSION_ID` | `src/actor.ts`, `cli/ccc.mjs` |

**Name rules** (`registerSession`, `src/sessions.ts`):

- **Same Claude id, or no id:** the process reattaches to its own row.
- **Holder still active:** if the current holder was active in the last 2 minutes, the newcomer gets `W1-2` … `W1-9`. Later calls still carry `X-CCC-Session: W1` (the env var), and the server maps them to `W1-N` by Claude id (`ownedName`).
- **Holder stale:** the newcomer takes over. The old Claude id goes on `superseded_claude_session_ids`, and every later call from it gets **409 `superseded`**: hooks, the CLI and `ccc wait`. A wait already in flight cannot take mail either (`takeUnread` guard). When a process takes its name back, it is removed from that list.
- **Concurrent registers** serialise on `pg_advisory_xact_lock(hashtext(name))`.

**Roles:**
- The roles are `orchestrator`, `worker`, `helper`, `auditor` and `other`.
- **Orchestrator:**
  - A partial unique index allows only one.
  - Only the owner grants or moves it (`POST /api/admin/sessions/:name/role`).
  - The address `orchestrator` always means the current holder. Questions to it are stored as `role:orchestrator`, so they follow the role if it moves.
- **`CCC_ROLE`** can request a role other than orchestrator, on first registration only.

**Accepted risk (spec §8):** anyone holding a device token can claim any session name, including the orchestrator's. Every caller is one of the owner's own sessions.

## 3. Delivery

- **Stop hook (end of turn):**
  1. `GET /api/inbox?peek=1`.
  2. If there is mail, print `{"decision":"block","reason":…}`, so Claude keeps going with the messages as its next instruction.
  3. Then `POST /api/inbox/ack {ids}`.
  - A lost ack means a duplicate next turn, never a lost message.
  - With `stop_hook_active` and no new mail, it allows the stop.
  - After 8 consecutive blocks, Claude Code overrides the hook.
- **`ccc wait`:**
  - Long-polls `/api/inbox/wait` in 25 s rounds; the server caps a round at 30 s.
  - It exits as soon as mail arrives and prints it.
  - Agents run it with Bash `run_in_background`, so its exit wakes them.
  - A wait counts as a heartbeat (the session is reachable) but not as activity.
- **MCP `get_inbox`** and **CLI `inbox`** take mail and mark it read on the spot. Use them when you want mail now.
- **Pause and resume** are messages of kind `control`. Delivering a pause flips `paused`. The board shows *pause pending* until it is delivered.
- **No mid-turn injection.** This was the owner's decision: mail lands only when a turn ends.

## 4. Watchdog (`src/watchdog.ts`, every minute)

- **Unreachable:** no heartbeat for **15 min** marks the session `unreachable`. The orchestrator gets a note: "<name> is unreachable: no heartbeat for 15 min. It needs a nudge in its terminal."
- **Idle ping:** no activity for **60 min** sends a `ping` message, at most once per hour, asking for a status report.
- **Heartbeats:** hooks send them as activity. The PostToolUse heartbeat is throttled to one per 60 s per process.

## 5. Hooks (`ccc install-hooks`)

| Event | Does | Notes |
|---|---|---|
| SessionStart | registers; prints the resume context plus the exact `ccc` command | Plain stdout becomes Claude's context |
| PostToolUse | activity heartbeat (throttled to 60 s) | |
| Notification (`permission_prompt`) | status `waiting_permission` with the prompt as the blocker | The blocker clears when the status changes |
| Stop | peek → block with mail → ack → status `idle` | |
| SessionEnd | status `offline` | Claude Code gives it about 1.5 s |

**Every hook fails open.** Each request has a 2 s timeout, and the process hard-exits at 2.4 s with code 0 and no output. A dead CCC never blocks Claude. If `CCC_SESSION` is not set, the hooks do nothing.

**MCP registration** uses `headersHelper` (`ccc mcp-headers`) instead of `${VAR}` headers. Claude Code blanks env vars whose names contain TOKEN, KEY, SECRET and similar words in remote headers.

## 6. Data (`migrations/001_init.sql`, schema `ccc`)

| Table | Holds |
|---|---|
| `devices` | label, token hash, revoked_at |
| `sessions` | name, role, device, Claude id, superseded ids, cwd, status, working_on, blocker, paused, heartbeat/activity/wait/ping timestamps, retired_at |
| `tasks` | title, body, assignee, status (`open/in_progress/blocked/done/cancelled`), result, blocker |
| `questions` | asker, addressee (`owner`, a name, or `role:orchestrator`), options (1–8), is_blocking, answer, status |
| `messages` | from, to, kind (`instruction/task/answer/question/control/note/ping`), body ≤ 64 KB, read_at |
| `events` | append-only audit: who did what, as JSON. Feeds the timeline and SSE |

- Ids are bigint identity, shown as `T12` and `Q7`.
- Money, PHI and similar rules do not apply here. The owner chose **no redaction**: treat the database as holding whatever sessions post.

## 7. API surface

Errors look like `{ "error": { "code", "message" } }`. A 500 is always generic.

- **Owner (cookie):**
  - `POST /api/admin/login|logout`
  - `GET|POST /api/admin/devices`, `POST /api/admin/devices/:id/revoke`
  - `POST /api/admin/sessions/:name/role|retire`
  - `GET /api/events`, `GET /api/stream` (SSE)
- **Agent (bearer token plus `X-CCC-Session`):**
  - `POST /api/sessions/register`, `GET /api/me`
  - `POST /api/status`, `POST /api/heartbeat`
  - `GET /api/inbox[?peek=1]`, `POST /api/inbox/ack`, `GET /api/inbox/wait`
- **Both:**
  - `GET /api/sessions`
  - `POST /api/messages`; `POST /api/broadcast` and `POST /api/control` (orchestrator only)
  - `GET|POST /api/tasks`, `POST /api/tasks/:id[/assign|/cancel]`
  - `GET|POST /api/questions`, `POST /api/questions/:id/answer|withdraw`
- **MCP** `/mcp` (stateless Streamable HTTP, agents only) has 15 tools:
  - Session: `whoami`, `report_status`, `get_inbox`, `list_sessions`.
  - Messages and questions: `send_message`, `ask_question`, `answer_question`, `list_questions`.
  - Tasks: `list_tasks`, `update_task`, `assign_task`, `reassign_task`, `cancel_task`.
  - Coordination: `broadcast`, `control`.
  - Orchestrator-only checks live in the domain functions, so REST and MCP enforce the same rules.
- **Static files:**
  - `/` serves the UI.
  - `/cli/ccc.mjs` serves the CLI.
  - `/healthz` is the health check.

## 8. Known limits and deferred items

- **One replica only.** Moving the in-process bus to Postgres `LISTEN/NOTIFY` would lift this.
- **MCP and `-N` names:** MCP calls map a `-N` newcomer to its own row only if Claude Code passes `CLAUDE_CODE_SESSION_ID` to the MCP `headersHelper`. This is unverified. Hooks and the CLI always do.
- **Deferred minors from the final review:**
  1. `ensureSession` can race the first register on a brand-new name and return a 500.
  2. Ordinary CLI commands use a 15 s timeout.
  3. Pings pile up on an unreachable session.
  4. Retiring a session is undone by its next call.
  5. The names `owner`, `system`, `all` and `orchestrator` are not reserved.
  6. MCP has no `withdraw_question`.
  7. `report_status` can't clear `workingOn`.
  8. A status report sent while unreachable leaves the status `unreachable`.
- **No notifications** (Telegram, email), **attachments** or **remote process control**. These are v1 non-goals.
