# Brimble Take-Home: Mini PaaS Pipeline

A one-page deployment pipeline that takes either a Git repo URL or uploaded project ZIP, builds it into an image using Railpack, runs it as a container, and serves it behind Caddy.

## Stack and decisions

- **Frontend**: Vite + React + TanStack Router + TanStack Query (single page).
- **API**: TypeScript + Express for quick, explicit control over SSE and process orchestration.
- **DB**: Postgres (instead of SQLite) to keep concurrent log writes + reads simple and robust in Compose.
- **Ingress**: Caddy is the only public ingress.
  - `/` -> frontend
  - `/api/*` -> API
  - `/apps/:id/*` -> dynamic app routes managed by Caddy Admin API.
- **Container orchestration for this take-home**: Docker socket from API container.
  - API clones repos, invokes Railpack, runs containers, configures routes.
- **Build backend**: BuildKit runs as a dedicated `buildkit` service.
  - API sets `BUILDKIT_HOST=tcp://buildkit:1234` for `railpack build`.

## Hard requirements coverage

- Single command startup via `docker compose up` (healthcheck-gated service ordering)
- Live log streaming over SSE (`GET /api/deployments/:id/logs`) with per-event SSE `id` for resume
- Logs persisted in Postgres and replayed on reconnect via `Last-Event-ID` or `?cursor=<logId>`
- Railpack-based image build (Railpack CLI in API container + BuildKit service)
- Caddy as single ingress for UI, API, and deployed apps (with serialized dynamic route mutations)
- Runtime readiness probe (per-attempt + global timeout) before marking deployment `running`
- Deterministic pipeline termination: clone/unzip/build each have hard timeouts with `SIGTERM -> SIGKILL` fallback

## Project layout

- `ARCHITECTURE.md` design rationale and data flow
- `docker-compose.yml` system topology
- `Caddyfile` base ingress config
- `api/` deployment API + pipeline worker + SSE
- `frontend/` one-page UI
- `sample-app/` simple Node app for test deployment source

## Run locally

Prereqs:

- Docker + Docker Compose plugin
- Internet access to pull base images and Railpack image
- Port `80` available on host (Caddy ingress)
- Docker daemon access with permission to mount `/var/run/docker.sock`
- Container runtime that allows `privileged` mode for BuildKit

Start:

```bash
docker compose up --build
```

Then open [http://localhost](http://localhost).

### Regression checks

All checks assume the stack is already up.

```bash
npm run check:routing      # Caddy dynamic route order + /apps/:id response
npm run check:sse          # live SSE stream + cursor replay + terminal event
npm run check:architecture # compose + caddy ingress invariants
npm run check:contracts    # runs architecture + routing + sse in order
```

`check:routing` verifies:

- An existing `running` deployment is routed by Caddy (create one first if needed).
- Reads Caddy routes through the Admin API (via the `api` container) and asserts the deployment route is ordered before the frontend catch-all route.
- Requests `/apps/:id/` and asserts the deployed app response is served (not frontend HTML).

`check:sse` verifies (creates its own deployment from `sample-app/`):

- Log events are emitted with SSE `id:` lines so clients can resume.
- A terminal event (`event: pipeline_done` or `event: pipeline_failed`) is eventually emitted.
- Reconnecting with the last seen cursor still produces a valid stream ending in the terminal event.

## API surface

- `POST /api/deployments` with either:
  - JSON body `{ "git_url": "https://..." }`
  - multipart form-data `project_file=<zip>`
- `GET /api/deployments`
- `GET /api/deployments/:id`
- `GET /api/deployments/:id/logs` (SSE)
- `DELETE /api/deployments/:id`

### SSE contract

- Log events use the default `message` event with payload `{ id, line, stream, timestamp }`.
- Each event is emitted with an SSE `id:` equal to the log ULID so clients can resume consistently.
- Replay cursor is accepted from `Last-Event-ID` header or `?cursor=<logId>` query param; backfill emits only logs strictly after the cursor.
- Terminal custom events are:
  - `event: pipeline_done` (payload: `{ status: "running" | "deleted", caddy_route? }`)
  - `event: pipeline_failed` (payload: `{ status: "failed", message? }`)
- `event: error` is intentionally **not** used as an application event name to avoid collision with native `EventSource.onerror` (which fires on transport errors and auto-reconnects).

### Deployment lifecycle statuses

Pipeline flow: `pending -> building -> deploying -> running | failed`

`DELETE /api/deployments/:id` transitions the record to the separate terminal status `deleted` (distinct from `failed`) and emits `event: pipeline_done` with `{ status: "deleted" }`. The full status union exposed by the API is therefore `pending | building | deploying | running | failed | deleted`.

### Pipeline timeouts (env-overridable)

- `CLONE_TIMEOUT_MS` (default `180000`)
- `UNZIP_TIMEOUT_MS` (default `120000`)
- `BUILD_TIMEOUT_MS` (default `1200000`)
- `READINESS_PROBE_TIMEOUT_MS` (default `3000`, per attempt; global readiness budget is 120s)

Timeouts send `SIGTERM`, then `SIGKILL` after a short grace period, mark the deployment `failed`, and emit `pipeline_failed`.

## Notes on deployed app expectations

- The app built by Railpack should listen on `PORT` (default `3000` in this project).
- The API currently infers exposed port from image metadata, with fallback behavior.
- API container installs Railpack with `curl -sSL https://railpack.com/install.sh | sh`.

## Brimble deployment + feedback

- Brimble deploy URL: `https://mini-pipeline-demo.brimble.app`
- Honest feedback write-up:

I deployed a simple Node hello-world app to Brimble to validate the flow from repo selection to live URL. The onboarding and first deploy were fast, and seeing a public URL come up quickly was great. The main friction was around failed deploy visibility: when one deploy failed due to a missing start command, I had to infer the cause from partial logs and retry with guessed fixes. I also hit uncertainty around runtime defaults (port/start command/build behavior) because those expectations were not obvious in the deploy form.

If I could change three things, I would add (1) clearer pre-deploy validation and required-field hints before submit, (2) a stronger failed-deploy summary panel with the likely root cause and next action, and (3) a persistent "last known good deploy" shortcut so rollback is one click. Overall, the core deploy loop is promising and fast, but the failure-debugging path needs more guidance for first-time users.

## Time spent / tradeoffs

- Time spent: `~16 hours`
- If I had another weekend:
  - rollback/redeploy by reusing previous image tags per deployment
  - durable job queue so in-flight pipelines survive API restarts (status reconciler)
  - integration test suite (vitest + supertest) for SSE replay, timeout path, and concurrent Caddy route mutations
- What I would rip out / replace before production:
  - The in-process Caddy mutation mutex: only safe for a single API replica. In production I would replace it with a distributed lock (Consul session or Postgres advisory lock) or move route mutations into a single leader worker.
  - BuildKit running in `privileged` mode inside Compose: fine for local dev parity, but in production the build plane should be an isolated rootless BuildKit or remote `buildkitd` cluster with per-tenant quotas, not a sibling container sharing the host daemon.
  - The Docker-socket-as-control-plane pattern (`/var/run/docker.sock` mounted into API): acceptable for a single-box take-home, but in production I would drive container lifecycle through a real scheduler (Nomad in Brimble's stack) rather than the local docker daemon.

## Founder walkthrough talking points

- Why Caddy Admin API was chosen: mirrors control-plane behavior and keeps ingress dynamic without restarts.
- Why SSE over WebSocket: log streams are one-directional and SSE is operationally simpler through proxies.
- Why custom event names `pipeline_done` / `pipeline_failed`: avoids colliding with native `EventSource.onerror`, which fires on transport errors and auto-reconnects.
- Why Postgres over SQLite in Compose: avoids file locking edge-cases under concurrent log writes + reads.
- Why serialized Caddy route mutations: `putCaddyRoute` does a read-modify-write on `srv0/routes`; a per-process mutex prevents concurrent deployments from clobbering each other's route inserts.
- Why per-attempt readiness timeout: a single hung TCP read cannot block the global readiness loop beyond 3s; deployments always progress to `running` or `failed` within the overall budget.
- Why command timeouts: builds never hang indefinitely; status is always transitioned to `failed` with a terminal SSE event.
- Failure model: each pipeline stage emits logs, updates status, sends terminal SSE event, and does best-effort cleanup (container stop/remove + Caddy route delete).
