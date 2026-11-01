# CCC projects — design

Date: 2026-11-01 · Owner: Ahmed Shaltoot · Extends: [2026-11-01-ccc-design.md](2026-11-01-ccc-design.md)

## 1. Intent

Ahmed wants to run **two (or more) projects at the same time** through one CCC. Some sessions work
on project 1, others on project 2. Each project behaves as its own team: its own orchestrator, its
own workers, tasks and questions. The owner still sees and directs everything from one UI.

Today CCC is a single team: one orchestrator (enforced by a unique index), `orchestrator` and `all`
resolve globally, and task results and watchdog notes go to that one holder. `sessions.project`
exists in the schema but nothing reads or writes it.

## 2. Decided (by Ahmed)

1. **One orchestrator per project.** It sees and directs only its project's sessions, tasks and
   questions. The owner sees everything.
2. **Project is chosen at launch** with `CCC_PROJECT`, like `CCC_SESSION`. It is set when the name
   is first created and then sticks to the name. Only the owner moves a session to another project.
3. **Projects appear automatically.** The first session naming a project creates it. There is no
   project table and no owner setup step. A typo makes a stray project that the owner fixes by moving
   the session.

## 3. Builder's calls (overridable)

- Sessions without `CCC_PROJECT` land in project **`default`**. Existing rows are back-filled to it.
- **Session names stay globally unique.** `W1` cannot exist in two projects. The identity, takeover
  and `-N` logic (main spec §6.2) is unchanged.
- An invalid `CCC_PROJECT` value falls back to `default` instead of failing: hooks must fail open.
- Project names use the session-name pattern: `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`.
- Tasks and questions **record their project at creation**. Moving a session later does not rewrite
  history; its open tasks stay in the old project.

## 4. Data

Migration `002_projects.sql` (never edit `001`):

- `sessions.project`: back-fill `'default'` where null, then `set default 'default'`, `set not null`,
  and the name-pattern check.
- `tasks.project text not null`: back-fill `'default'`.
- `questions.project text not null`: back-fill `'default'`.
- Replace `sessions_one_orchestrator` with a unique index on `(project)` where
  `role = 'orchestrator' and retired_at is null`.
- Indexes on `tasks (project)` and `questions (project)`.

No `projects` table: the list of projects is `select distinct project` over live sessions, plus
projects that still have open tasks or questions.

## 5. Isolation rules

The **scope project** of a request is the caller's `session.project` for an agent, or the project
the owner names (optional; absent means "all projects" where that makes sense).

| Operation | Agent | Owner |
|---|---|---|
| Address `orchestrator` | its project's orchestrator; 409 `no_orchestrator` if none | needs a project, else 400 |
| Address a session by name | only within its project, else 403 `other_project` | any session |
| `broadcast` / `control all` | its project's sessions (orchestrator only) | optional project; absent = every project |
| List sessions / tasks / questions | its project only (the `project` query param is ignored) | optional `?project=` filter |
| Question `role:orchestrator` | asker's project orchestrator | — |
| Task results and blockers | that task's project orchestrator | — |
| Watchdog "unreachable" note | that session's project orchestrator | — |
| Grant orchestrator | — | demotes only the current holder in that session's project |
| Move session | — | new owner route. An orchestrator being moved drops to `worker`. |

The checks live in the domain functions (`sessions`, `messages`, `tasks`, `questions`,
`watchdog`), not in the routes, so REST and MCP agree (existing invariant).

## 6. Surfaces

**Identity flow.**
- The CLI and every hook send `X-CCC-Project` from `CCC_PROJECT` on each request.
- The server uses it only when creating a name, in `registerSession` and in `ensureSession` (the
  auto-create in `resolveActor`).
- Afterwards the stored `session.project` is authoritative and the header is ignored.
- The SessionStart welcome text names the project.

**REST** (all additive; existing clients keep working):
- `GET /api/sessions`, `/api/tasks`, `/api/questions`: optional `?project=` (owner only; agents are
  always scoped).
- `POST /api/broadcast`, `POST /api/control`: optional `project` (owner only).
- `POST /api/admin/sessions/:name/project {project}`: owner moves a session.
- `GET /api/projects`: per project, live session count, orchestrator name, open tasks, open
  questions. Agents get only their own project.
- Session JSON gains `project`. Task and question JSON gains `project`.

**MCP.** Same tools and names. They pick up the scoping from the domain functions. No new tools.

**CLI.**
- `register` and `status` print the project.
- `sessions` shows a project column.
- Usage text documents `CCC_PROJECT`.
- Still a single file with no dependencies.

**Owner UI.**
- Header project picker: **All** plus each project. It filters the board, questions and tasks, and
  is remembered in `localStorage`.
- A project chip on session cards and in the detail view.
- Controls → Sessions: "Move to project" (free text with suggestions from `/api/projects`).
- Controls → Everyone: a project selector for broadcast and pause/resume all, defaulting to
  "All projects".
- Assign a task: the session dropdown lists only sessions in the selected project. A task takes its
  assignee's project.
- Every new piece of text is built with `h()`. No `innerHTML` (existing invariant).

**Docs.**
- README: launch line `CCC_PROJECT=ihop CCC_SESSION=W1 claude`.
- `knowledge-base.md`: the projects section and the isolation table.
- `agent-prompts.md`: mention the project.
- `deploy.md`: add `X-CCC-Project` to the pass-through headers.

## 7. Testing

Test first (RED, then GREEN). Then the full suite and `npm run check`, quoting the pass count. New
cases:

- Migration back-fills existing sessions, tasks and questions to `default`.
- Two projects can each hold an orchestrator. Granting in one leaves the other alone.
- An agent's `orchestrator` and `all` resolve within its project. Broadcast does not leak.
- Addressing a session in another project returns 403 `other_project`, over both REST and MCP.
- Agent list endpoints ignore `?project=` for other projects.
- `CCC_PROJECT` is applied on first registration and ignored afterwards. An invalid value falls
  back to `default`.
- Owner move: changes the project, demotes an orchestrator, and leaves open tasks in the old
  project.
- Watchdog note and task-result routing go to the right project's orchestrator.
- Hooks still exit 0 with no stdout when CCC is down (existing invariant still holds).
- UI test still passes the no-`innerHTML` check.

## 8. Non-goals

- Per-project permissions or tokens. Device tokens stay global.
- Per-project owners or a second owner login.
- Cross-project messaging for agents. Only the owner bridges projects.
- Renaming, archiving or deleting a project. A project disappears when nothing references it.

## 9. Risks

- **Typos create stray projects** (accepted, decision 3). Visible in the header picker and fixed
  by a move.
- **Old CLI copies** on machines don't send `X-CCC-Project`. Their sessions land in `default` until
  re-downloaded (`curl …/cli/ccc.mjs`) or moved by the owner. This is safe, not broken.
