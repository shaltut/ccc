# Deploying CCC

This guide is for the agent that deploys CCC on the VM. It covers what the deployment needs and how to prove it works. Choices about the host, DNS and TLS are left to you.

## What you are deploying

- One stateless HTTP container (Node 22), plus PostgreSQL 14+ (17 is what CI uses).
- Port `8080` inside the container. `GET /healthz` returns `200 {"ok":true}`.
- **Migrations run automatically on boot.** They take a Postgres advisory lock, so a restart is safe.
- **Run exactly one replica.** Live updates and long-polls use an in-process event bus, so a second replica would miss events.

## Image

There are two ways to get it.

1. **From GHCR.** CI builds `ghcr.io/shaltut/ccc:latest` and `:sha-<7>` on every push to `main`.
   - The repo is private, so the package is private.
   - Log in on the VM with a GitHub token that has `read:packages`: `echo $TOKEN | docker login ghcr.io -u <user> --password-stdin`.
2. **From source.** Run `git clone https://github.com/shaltut/ccc && cd ccc && docker build -t ccc:local .`

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://user:pass@host:5432/db`. The app creates schema `ccc`. |
| `CCC_ADMIN_PASSWORD` | yes | At least 12 characters. This is the owner's UI login. Changing it signs out every browser. |
| `CCC_PUBLIC_URL` | yes | The public HTTPS origin, e.g. `https://ccc.example.com`, with no trailing slash. |
| `PORT` | no | Default `8080`. |

Keep secrets out of the repo and the image. Use the VM's secret store or a root-only `.env`.

## Option A: compose (app + bundled Postgres)

```sh
cp .env.example .env    # then edit: POSTGRES_PASSWORD, DATABASE_URL (same password), CCC_ADMIN_PASSWORD, CCC_PUBLIC_URL
docker compose up -d
docker compose ps        # app should become "healthy"
```

The data lives in the named volume `ccc-pg`, so back it up. **Never** run `docker compose down -v`: it deletes the volume and all of CCC's history.

## Option B: existing Postgres

```sh
docker run -d --name ccc --restart unless-stopped -p 127.0.0.1:8080:8080 \
  -e DATABASE_URL=... -e CCC_ADMIN_PASSWORD=... -e CCC_PUBLIC_URL=https://ccc.example.com \
  ghcr.io/shaltut/ccc:latest
```

The database user needs to be able to `create schema` on first boot, or you can pre-create schema `ccc` and make that user its owner.

## Reverse proxy and TLS (required)

- **Serve HTTPS only.** The owner cookie is `Secure`, and device tokens travel as bearer headers.
- **Don't break the two long-lived endpoints:**
  - `/api/stream` is Server-Sent Events. Disable buffering and keep the connection open; the server sends a keepalive every 25 s.
  - `/api/inbox/wait` is a long-poll of up to 30 s.
  - Set the proxy's read timeout to at least **60 s**.
- **Pass these request headers through unchanged:** `Authorization`, `X-CCC-Session`, `X-CCC-Claude-Session`, `Mcp-Session-Id`.
- **Limit body size to about 1 MB.** Message bodies are capped at 64 KB.

nginx sketch:

```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  proxy_read_timeout 90s;
  client_max_body_size 1m;
}
```

Caddy: `reverse_proxy 127.0.0.1:8080 { flush_interval -1 }`.

## Verify the deployment

Run these against the public URL.

1. `curl -s https://ccc.example.com/healthz` returns `{"ok":true}`.
2. `curl -sI https://ccc.example.com/` returns `200` and `text/html`.
3. `curl -s https://ccc.example.com/cli/ccc.mjs | head -1` returns `#!/usr/bin/env node`.
4. Log in at the URL with `CCC_ADMIN_PASSWORD`. The board loads and the header shows **live**. If it stays on "reconnecting", the proxy is buffering SSE.
5. **Controls → Devices:** create a token labelled `deploy-check`. Then, from any machine:

   ```sh
   curl -fsSo /tmp/ccc.mjs https://ccc.example.com/cli/ccc.mjs
   HOME=/tmp/ccc-check node /tmp/ccc.mjs setup https://ccc.example.com <token>
   CCC_SESSION=deploy-check HOME=/tmp/ccc-check node /tmp/ccc.mjs register
   ```

   You should see `Registered as deploy-check`.
6. `CCC_SESSION=deploy-check HOME=/tmp/ccc-check node /tmp/ccc.mjs wait --timeout 40` waits about 40 s, then prints `(no messages before timeout)`. If it fails sooner, the proxy is cutting the long-poll.
7. Clean up: in **Controls**, retire `deploy-check` and revoke its token.

Report back the URL, the image tag or commit, where the data volume lives, and the result of each step.

## Operations

- **Logs.** The app logs to stdout with a `[ccc]` prefix. Unexpected errors log the stack and return a generic 500.
- **Shutdown.** `SIGTERM` drains for up to 10 s.
- **Upgrade.** Pull the new image and restart. Migrations apply on boot.
- **Rollback.** Earlier `:sha-*` tags stay available. Migrations only add things, but check `migrations/` before rolling back across one.
- **Backup.** Use `pg_dump --schema=ccc`.
