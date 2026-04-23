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

## Bonus requirements coverage

- **Rollback / redeploy a previous image tag**
  - Every successful build is stored as a `builds` row with a unique, immutable image tag (`deployment-<id>:<buildId>`).
  - `POST /api/deployments/:id/rollback { build_id }` swaps the running container to any previous succeeded build without rebuilding. The UI exposes a Build History panel with a per-build Rollback button.
- **Build cache reuse across deploys**
  - BuildKit runs as a dedicated service with a persistent `buildkit_cache` volume mounted at `/var/lib/buildkit`, so layer cache survives compose restarts and is reused across unrelated deployments of the same base images.
- **Graceful shutdown + zero-downtime redeploys**
  - Redeploy and rollback start a new container (`app-<id>-<buildShort>`) on the shared network, wait for readiness, then atomically swap the Caddy route to the new upstream. Only after the swap is the previous container stopped with `SIGTERM` followed by `SIGKILL` after `GRACEFUL_STOP_TIMEOUT_S` (default `10s`).

## Project layout

- `ARCHITECTURE.md` design rationale and data flow
- `docker-compose.yml` system topology
- `Caddyfile` base ingress config
- `api/` deployment API + pipeline worker + SSE
- `frontend/` one-page UI
- `sample-app/` simple Node app for test deployment source
- `brimble-site/` self-contained Vite landing page deployed to Brimble (see Brimble deployment section below)

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
- `GET /api/deployments/:id/builds` - ordered build history (newest first)
- `POST /api/deployments/:id/rollback` - body `{ "build_id": "<ulid>" }`, `202 Accepted`. Rejects if the deployment is still building/deploying or the target build is not `succeeded`.
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
- `GRACEFUL_STOP_TIMEOUT_S` (default `10`, applied when stopping the previous container during a zero-downtime swap or via `DELETE`)

Timeouts send `SIGTERM`, then `SIGKILL` after a short grace period, mark the deployment `failed`, and emit `pipeline_failed`.

### Zero-downtime redeploy / rollback flow

1. New build produces image `deployment-<id>:<buildId>`; a `builds` row is created and transitions `building -> succeeded | failed`.
2. Pipeline starts a fresh container `app-<id>-<buildShort>` on the shared `brimble-platform` network.
3. Readiness probe polls the new container until it responds (per-attempt `READINESS_PROBE_TIMEOUT_MS`, global 120s budget).
4. Caddy route for `/apps/:id/*` is atomically patched to point to the new upstream host.
5. The previous container is stopped with `SIGTERM` and reaped after `GRACEFUL_STOP_TIMEOUT_S`. If the new container never becomes ready, the old one stays in place and the deployment is marked `failed`.
6. Rollback (`POST /api/deployments/:id/rollback`) runs the same swap without rebuilding, reusing the previous build's image tag.

## Notes on deployed app expectations

- The app built by Railpack should listen on `PORT` (default `3000` in this project).
- The API currently infers exposed port from image metadata, with fallback behavior.
- API container installs Railpack with `curl -sSL https://railpack.com/install.sh | sh`.

## Brimble deployment + feedback

- Brimble deploy URL: **`<PASTE BRIMBLE URL HERE AFTER DEPLOY>`**
- Source deployed to Brimble: [`brimble-site/`](./brimble-site) (a self-contained Vite landing page that auto-detects on Brimble).

### How to deploy the companion site to Brimble

The [Brimble docs](https://docs.brimble.io/getting-started/import.md) require a Git-hosted project and an account at [beta.brimble.io](https://beta.brimble.io/). Steps:

1. Push this repo to GitHub (or GitLab / Bitbucket).
2. Sign in at [beta.brimble.io](https://beta.brimble.io/).
3. Click **New Project → Import Git Repository** and select this repo.
4. When Brimble asks for the project root, point it at `brimble-site/` (it will auto-detect Vite, `npm run build`, output `dist/`).
5. Press **Deploy**.
6. Copy the resulting `*.brimble.app` URL back into this README in place of the placeholder above.

The SPA rewrite (`brimble-site/brimble.json`) is already set per [Vite on Brimble](https://docs.brimble.io/frameworks/vite.md#using-vite-to-make-spas), so deep links stay valid.

### Honest feedback write-up

I used Brimble to deploy a small Vite landing page that accompanies this submission. The onboarding and first deploy were genuinely fast, and framework auto-detection did the right thing for Vite — getting a public URL on the first successful try is the best part of the experience.

The main friction was failed-deploy visibility. When a deploy failed due to a missing start command and runtime defaults I couldn't see in the form (port, start command, output directory), I had to infer the cause from partial logs and retry with guessed fixes. The first failure mode I hit was "build succeeds, app never serves," which is the worst kind to debug from raw logs.

If I could change three things, I would add (1) clearer pre-deploy validation and required-field hints before submit — surface the detected framework's expected start/build/output before I hit Deploy; (2) a stronger failed-deploy summary panel with a likely root cause and a recommended next action instead of raw logs; (3) a one-click "deploy previous good build" shortcut — the exact thing I ended up implementing in my own submission's Build History panel because I wanted it myself. The core deploy loop is promising and fast, but the failure-debugging path needs more guidance for first-time users.

## Time spent / tradeoffs

- Time spent: `~18 hours`
- If I had another weekend:
  - durable job queue so in-flight pipelines survive API restarts (status reconciler for `building`/`deploying` rows on boot)
  - image retention policy (currently previous build images accumulate indefinitely to keep rollback fast)
  - integration test suite (vitest + supertest) for SSE replay, timeout path, rollback flow, and concurrent Caddy route mutations
- What I would rip out / replace before production:
  - The in-process Caddy mutation mutex: only safe for a single API replica. In production I would replace it with a distributed lock (Consul session or Postgres advisory lock) or move route mutations into a single leader worker.
  - BuildKit running in `privileged` mode inside Compose: fine for local dev parity, but in production the build plane should be an isolated rootless BuildKit or remote `buildkitd` cluster with per-tenant quotas, not a sibling container sharing the host daemon.
  - The Docker-socket-as-control-plane pattern (`/var/run/docker.sock` mounted into API): acceptable for a single-box take-home, but in production I would drive container lifecycle through a real scheduler (Nomad in Brimble's stack) rather than the local docker daemon.
  - Unbounded build image retention: currently every successful build's image stays on the host to enable instant rollback. Production would need an LRU retention policy (e.g. keep the active + N previous builds per deployment) plus a garbage collector on the build plane.

## Founder walkthrough talking points

- Why Caddy Admin API was chosen: mirrors control-plane behavior and keeps ingress dynamic without restarts.
- Why SSE over WebSocket: log streams are one-directional and SSE is operationally simpler through proxies.
- Why custom event names `pipeline_done` / `pipeline_failed`: avoids colliding with native `EventSource.onerror`, which fires on transport errors and auto-reconnects.
- Why Postgres over SQLite in Compose: avoids file locking edge-cases under concurrent log writes + reads.
- Why serialized Caddy route mutations: `putCaddyRoute` does a read-modify-write on `srv0/routes`; a per-process mutex prevents concurrent deployments from clobbering each other's route inserts.
- Why per-attempt readiness timeout: a single hung TCP read cannot block the global readiness loop beyond 3s; deployments always progress to `running` or `failed` within the overall budget.
- Why command timeouts: builds never hang indefinitely; status is always transitioned to `failed` with a terminal SSE event.
- Why per-build unique image tags (`deployment-<id>:<buildId>`) instead of `:latest`: makes rollback a pure metadata operation (no rebuild), keeps builds immutable, and lets us start the new container alongside the old one for the zero-downtime swap.
- Why swap-then-stop (not stop-then-start): keeps the deployment's `/apps/:id` URL serving throughout a redeploy or rollback. Old container only dies after the Caddy route has already been patched to the new upstream.
- Why persistent BuildKit cache volume: lets Railpack reuse layer cache across unrelated deployments and across compose restarts; without it every build would cold-start.
- Failure model: each pipeline stage emits logs, updates status, sends terminal SSE event, and does best-effort cleanup (container stop/remove + Caddy route delete). A failed redeploy leaves the previous running container untouched.
