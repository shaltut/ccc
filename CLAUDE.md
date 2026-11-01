# CCC: Claude Command Center

A self-hosted coordination hub for Claude Code sessions: one inbox and board per named session, an orchestrator role, and an owner UI. It is a single Node service on Postgres.

**What to read:**

| You need | Read |
|---|---|
| How it works | [docs/knowledge-base.md](docs/knowledge-base.md) |
| What it's for | [docs/use-cases.md](docs/use-cases.md) |
| To deploy it | [docs/deploy.md](docs/deploy.md) |
| A prompt for an agent that will *use* CCC | [docs/agent-prompts.md](docs/agent-prompts.md) |
| The design authority | [docs/superpowers/specs/2026-11-01-ccc-design.md](docs/superpowers/specs/2026-11-01-ccc-design.md) |

When the code and the spec disagree, say so. Don't silently pick one.

## Commands

```sh
npm ci
npm run check        # tsc --noEmit (strict, noUncheckedIndexedAccess, erasableSyntaxOnly)
npm test             # node:test, serial; needs Postgres (below); ~40 s
npm start            # node src/main.ts; needs DATABASE_URL, CCC_ADMIN_PASSWORD (12+), CCC_PUBLIC_URL
docker compose up -d # app + postgres:17 on :8080 (copy .env.example to .env first)
```

**Test database.** `CCC_TEST_DATABASE_URL` defaults to `postgres://postgres:ccc@127.0.0.1:5544/ccc_test`. To create one:

```sh
docker run -d --name ccc-pg -e POSTGRES_PASSWORD=ccc -e POSTGRES_DB=ccc_test -p 127.0.0.1:5544:5432 postgres:17-alpine
```

**`testApp()` resets the shared `ccc` schema.** Use one per test file. A second one belongs only in the file's last test.

## Stack and layout

- **Runtime.** Node ≥ 22.18 runs `.ts` directly (type stripping), so there is no build step. Imports use `.ts` extensions. Only erasable TypeScript is allowed: no enums, namespaces or parameter properties.
- **Libraries.** Hono with @hono/node-server; postgres.js 3.4.9 (camelCase transform, int8 parsed as Number); zod 4; @modelcontextprotocol/sdk (stateless Streamable HTTP).
- `src/`: one domain per file.
  - `sessions`, `messages`, `tasks`, `questions`, `watchdog`, `auth`, `events`: the domains.
  - `actor`: request identity and permission guards.
  - `api` and `work-routes`: REST. `mcp`: MCP tools.
  - `app`: wiring and errors. `main`: boot.
- `cli/ccc.mjs`: the zero-dependency CLI and the Claude Code hooks. The server serves it at `/cli/ccc.mjs`. It must stay a single file with no dependencies.
- `public/`: vanilla-JS owner UI. **Never use `innerHTML`** or similar; `h()` builds every node from text. A test enforces this.
- `migrations/NNN_*.sql`: plain SQL, applied on boot under an advisory lock. Add a new file; never edit an applied one.

## Invariants (tests pin these; keep them)

- **Hooks fail open.** Every hook exits 0 with no stdout within about 2.5 s when CCC is down or slow (2 s request timeout, 2.4 s hard exit). CCC must never get in an agent's way.
- **Delivery is peek, then ack.** A message is marked read only after the hook has printed it. A duplicate is acceptable; a loss is not.
- **Identity:**
  - A superseded Claude id gets 409 on every path, including an in-flight `ccc wait`.
  - A `-N` newcomer acts as its own row.
  - A process that takes its name back is not locked out.
- **Orchestrator:**
  - Only one session holds the role, and only the owner grants it.
  - Orchestrator-only checks live in the domain functions, so REST and MCP agree.
- **Agent text is inert in the UI.** Every piece is a text node.
- **Owner-only routes call `requireOwner`.** Agents never reach them.
- **Errors use the envelope** `{error:{code,message}}`. A 500 is always generic.

## Working rules

- **Test first.** Write a failing test (RED), then the fix (GREEN). Run the whole suite before claiming done, and quote the pass count.
- **Keep it small.** No speculative abstractions, no new dependencies for what a few lines can do. Keep files focused and under about 800 lines.
- **Out of scope by owner decision:**
  - no redaction or anonymisation
  - no remote process control
  - no mid-turn message injection
  - one replica
  - TLS and deployment belong to the VM's deploy agent
- **Don't commit secrets.** `.env` is gitignored. Device tokens are shown once and stored hashed.
- **CI** (`.github/workflows/ci.yml`) runs check and test on every push. On `main` it also pushes `ghcr.io/shaltut/ccc:latest` and `:sha-<7>`.
