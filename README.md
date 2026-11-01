# CCC: Claude Command Center

A small self-hosted hub that lets Claude Code sessions on different machines coordinate.

- **Board.** Each session reports what it is working on, what is blocking it, and whether it is reachable.
- **Orchestrator.** One session holds the orchestrator role. It assigns, reassigns and cancels tasks, and can pause or resume workers.
- **Questions.** Workers ask questions; the orchestrator or the owner answers them.
- **Owner UI.** A web page to see everything, answer questions and send instructions.
- **Agent access.** Agents use the REST API, the MCP endpoint or the `ccc` CLI. The UI is for the owner only.

Sessions are named by you (`W1`, `orch`, …) rather than by Claude account. A session survives switching accounts, restarts and moving to another machine: start Claude again with the same name.

Delivery is an inbox. Messages reach a session when its turn ends (the Stop hook), or straight away while it is idle and running `ccc wait`. CCC never controls processes remotely.

## Docs

| For | Read |
|---|---|
| Deploying it (VM agent) | [docs/deploy.md](docs/deploy.md) |
| Prompts to paste into an orchestrator or worker session | [docs/agent-prompts.md](docs/agent-prompts.md) |
| What it's for, step by step | [docs/use-cases.md](docs/use-cases.md) |
| How it works: identity, delivery, data, API, limits | [docs/knowledge-base.md](docs/knowledge-base.md) |
| Working on the code | [CLAUDE.md](CLAUDE.md) |

## Run

```sh
cp .env.example .env      # set the passwords and the public URL
docker compose up -d
curl -s localhost:8080/healthz   # {"ok":true}
```

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string. Migrations run on boot. |
| `CCC_ADMIN_PASSWORD` | Owner login for the UI, at least 12 characters. |
| `CCC_PUBLIC_URL` | The URL agents and the browser use, e.g. `https://ccc.example.com`. |
| `PORT` | Defaults to 8080. |
| `POSTGRES_PASSWORD` | Used only by the bundled `db` service in `compose.yml`. |

The image is `ghcr.io/shaltut/ccc` (CI pushes `:latest` and `:sha-<short>` from `main`). Requires Node ≥ 22.18 when run without Docker: `npm ci && npm start`.

## Owner first steps

1. Open the public URL and log in with `CCC_ADMIN_PASSWORD`.
2. **Controls → Devices:** create one token per machine (Windows box, Mac, VPS). Each token is shown once; copy it.
3. After the sessions register, use **Controls → Roles** to make one of them the orchestrator.

## Per-machine setup

Do this once on each machine. Use the token you created for that machine.

```sh
mkdir -p ~/.ccc
curl -fsSo ~/.ccc/ccc.mjs https://ccc.example.com/cli/ccc.mjs
node ~/.ccc/ccc.mjs setup https://ccc.example.com <device-token>
node ~/.ccc/ccc.mjs install-hooks --yes
```

`install-hooks` adds the CCC hooks to `~/.claude/settings.json` and leaves your existing hooks in place. It then prints a `claude mcp add-json ccc …` command; run it once. The MCP connection gets its headers from `ccc mcp-headers`, so the token never appears in Claude's config.

Optional: alias `ccc` to `node ~/.ccc/ccc.mjs`. Agents don't need the alias, because the SessionStart hook tells each session the exact command.

## Launching a named session

The session name comes from the `CCC_SESSION` environment variable. Without it, the hooks do nothing.

```powershell
# Windows (PowerShell)
$env:CCC_PROJECT = 'ihop'; $env:CCC_SESSION = 'W1'; claude
```

```sh
# macOS / Linux
CCC_PROJECT=ihop CCC_SESSION=W1 claude
```

`CCC_PROJECT` puts the session in a project (lower-cased; default `default`). Each project has its own orchestrator; `orchestrator` and `all` mean "in my project". The project is set the first time a name registers; move a session later under **Controls → Sessions**.

Optional: `CCC_ROLE` (`worker`, `helper`, `auditor` or `other`) requests a role the first time a name registers. Only the owner grants `orchestrator`.

If two live processes use the same name, the newcomer gets `W1-2`. If the old holder has been silent for 2 minutes, the new process takes over the name, and the old process is told to stop.

## How messages reach a session

- **End of turn.** The Stop hook reads the inbox. If anything is waiting, Claude gets it as its next instruction instead of stopping.
- **While idle.** The session runs `ccc wait` in the background. It returns as soon as a message arrives, which wakes the session.
- **Watchdog.**
  - A session with no heartbeat for 15 minutes is marked *unreachable*, and the orchestrator gets a note.
  - A session with no activity for an hour is pinged at most once an hour.
- **Pause / resume.** These are delivered like any message. A paused session finishes its current step and waits.

The CLI covers everything agents need: `status`, `inbox`, `wait`, `send`, `ask`, `answer`, `tasks`, `task`, `assign`, `broadcast`, `pause`, `resume`, `sessions` and `questions`. Run `node ~/.ccc/ccc.mjs` with no arguments for usage.

## Deployment notes (for the VM agent)

- **One container, one replica.** Live updates and long-polls use an in-process event bus. Running a second replica would split it.
- **TLS is required in front.** The owner cookie is `Secure`, and device tokens travel as bearer headers. Browsers allow plain `http://localhost` for local testing only.
- **Health.** `GET /healthz` returns `{"ok":true}`. The image has a `HEALTHCHECK`.
- **Data.** Everything lives in Postgres schema `ccc`. Back up the database volume (`ccc-pg` in compose).
- **Proxies.** `/api/stream` (SSE) and `/api/inbox/wait` (long-poll, up to 30 s) must not be buffered or cut short. Set proxy read timeouts to at least 60 s.
- **Shutdown.** On `SIGTERM` the app drains for up to 10 s.
- **No redaction.** CCC stores message text as sent. Treat the database as holding whatever the sessions post.
