# Architecture Plan

This document answers the six required design questions before any source code is created.

## 1) Hard requirements that cause immediate disqualification

These are strict pass/fail requirements from the prompt:

1. **`docker compose up` must bring up the full system end-to-end** on a clean machine.
   - Frontend, API, DB, Caddy, and all runtime plumbing must work with a single command.
2. **Live log streaming must be real-time SSE or WebSocket**, not polling.
   - Logs must stream during build/deploy execution and remain available afterward.
3. **Railpack must build images** for user-provided app source.
   - No handwritten Dockerfiles for deployed apps.
4. **Deployed app must run in Docker and be fronted by Caddy** as the single ingress.
   - Caddy routes dynamic per-deployment paths.
5. **Brimble deploy + honest feedback write-up must be submitted**.
   - Outside code execution, but mandatory for final submission.

Project execution will prioritize these requirements over optional polish.

## 2) Exact data flow: Git URL submission -> running container behind Caddy

### End-to-end flow

1. User submits `git_url` in frontend.
2. Frontend `POST /api/deployments` to API.
3. API creates `Deployment` row with status `pending`.
4. API immediately enqueues async pipeline worker (non-blocking HTTP response).
5. Pipeline stages:
   - `pending` -> clone repo to temp workspace.
   - `building` -> run `railpack build` and capture stdout/stderr.
   - Persist each log line to `Log` table and broadcast to active SSE clients.
   - On successful build, set deterministic image tag `deployment-{id}:latest`.
   - `deploying` -> stop/remove previous container (if redeploy path), then `docker run` new container on internal Docker network.
   - Discover app container port (strategy: inspect metadata + fallback to configured default `3000`, with override support).
   - Configure Caddy route via Admin API to map `/apps/{id}/*` to container upstream.
   - Update `Deployment` with `container_id`, `caddy_route`, `status=running`.
6. If any step fails (including clone/unzip/build timeouts):
   - Persist error log lines.
   - Set status `failed`.
   - Emit SSE terminal event `pipeline_failed` with `{ status: "failed", message? }`.
7. On success, emit SSE terminal event `pipeline_done` with `{ status: "running", caddy_route }`.
8. Frontend displays deployment list and selected deployment log stream.

### Key technical constraints

- API container mounts Docker socket to control sibling containers on host daemon.
- Deployed app containers are attached to a shared Docker network reachable by Caddy.
- Caddy static base config routes:
  - `/` -> frontend
  - `/api/*` -> API
- Dynamic app routes are installed/removed using Caddy Admin API.

## 3) Clean API surface and resource model

## Resource model

### Deployment

```ts
type DeploymentStatus =
  | "pending"
  | "building"
  | "deploying"
  | "running"
  | "failed"
  | "deleted";

interface Deployment {
  id: string; // ulid
  git_url: string;
  status: DeploymentStatus;
  image_tag: string | null;
  container_id: string | null;
  caddy_route: string | null;
  created_at: string; // ISO timestamp
  updated_at: string; // ISO timestamp
}
```

### Log

```ts
type LogStream = "stdout" | "stderr";

interface Log {
  id: string; // ulid
  deployment_id: string;
  line: string;
  stream: LogStream;
  timestamp: string; // ISO timestamp
}
```

## HTTP API routes

### `POST /api/deployments`

- Request: `{ git_url: string }`
- Response: `201` with `Deployment`
- Behavior:
  - Validates URL.
  - Persists deployment `pending`.
  - Starts async pipeline immediately.

### `GET /api/deployments`

- Response: `Deployment[]` sorted `created_at desc`.

### `GET /api/deployments/:id`

- Response: `Deployment`
- `404` if missing.

### `GET /api/deployments/:id/logs` (SSE)

- Streams:
  - Backfill of persisted logs first (honoring resume cursor).
  - Then live log events as they arrive.
- Cursoring:
  - Each log event includes SSE `id:` equal to log ULID.
  - Reconnect resume cursor can be supplied via `Last-Event-ID` header or `?cursor=<logId>`.
  - Backfill honors cursor and only emits logs strictly after that cursor.
- Event payload format:
  - default `message` event with JSON `{ id, line, stream, timestamp }`
- Terminal events (custom names to avoid colliding with native `EventSource.onerror`):
  - `event: pipeline_done` with payload `{ status: "running" | "deleted", caddy_route?: string }`
  - `event: pipeline_failed` with payload `{ status: "failed", message?: string }`

### `DELETE /api/deployments/:id`

- Stops/removes deployment container if present.
- Removes Caddy dynamic route via the Admin API (under a process-local mutex).
- Keeps deployment record for audit, clears container metadata, transitions status to the terminal value `deleted`, and emits a final `pipeline_done` SSE event with `{ status: "deleted" }`.

## 4) SSE log streaming end-to-end

## Pipeline log capture

- Every pipeline command runs via child process (`spawn`) with streaming stdout/stderr.
- Data is line-buffered, normalized, and fan-out published through:
  1. DB persistence (`logs` table)
  2. in-memory subscriber hub keyed by `deployment_id`

## SSE connection behavior

1. Client opens `EventSource` to `/api/deployments/:id/logs`.
2. Server writes headers:
   - `Content-Type: text/event-stream`
   - `Cache-Control: no-cache`
   - `Connection: keep-alive`
3. Server sends existing logs from DB (scroll-back).
4. Server subscribes connection to in-memory live stream.
5. As logs arrive, server sends:
   ```
   id: <log-ulid>
   data: {"id":"<log-ulid>","line":"...","stream":"stdout","timestamp":"..."}

   ```
6. On pipeline completion:
   - success -> `event: pipeline_done` with `{ status: "running", caddy_route }`
   - failure/timeout -> `event: pipeline_failed` with `{ status: "failed", message? }`
   - delete -> `event: pipeline_done` with `{ status: "deleted" }`
   - connection may remain open briefly then close.
7. Client closes stream on terminal event or manual selection change.

## Reliability notes

- Heartbeat comments (`:keepalive`) every 15s avoid idle disconnects.
- SSE replay includes all persisted logs (or only logs after a resume cursor), so refresh does not lose context.
- `runCommand` awaits all in-flight `addLog` writes before resolving/rejecting, so the terminal SSE event never races ahead of the final log line.
- Pipeline commands (`git clone`, `unzip`, `railpack build`) all run under hard timeouts and are terminated with `SIGTERM -> SIGKILL` on breach.
- Runtime readiness probes use a per-attempt timeout (`READINESS_PROBE_TIMEOUT_MS`) inside a 120s global budget so a hung upstream cannot stall the pipeline.

## 5) Docker Compose topology (services, communication, volumes)

## Services

1. **`frontend`**
   - Vite + React + TanStack Router + TanStack Query app.
   - Exposes internal `5173`.
2. **`api`**
   - Node + TypeScript + Express API.
   - Runs migration/init on startup.
   - Exposes internal `3001`.
   - Mounts `/var/run/docker.sock`.
3. **`db`**
   - Postgres 16 for robust concurrent writes and persistence.
   - Exposes internal `5432`.
4. **`caddy`**
   - Public ingress on `80`.
   - Admin API on internal `2019`.
   - Base routes to frontend/API; dynamic routes for apps.

## Networks/volumes

- Shared Docker network `brimble-platform` (declared with an explicit `name:` in compose so the API attaches newly-run deployment containers to the same network Caddy uses).
- Volume `postgres_data` for DB persistence.
- Container-local tmpfs for clone/unzip/build workspace under `/tmp`.

## Service healthchecks (compose)

- `api`: `curl -fsS http://localhost:3001/health`
- `frontend`: in-process `fetch('http://localhost:5173/')` via `node -e` (base image has no `curl`/`wget`)
- `caddy`: `caddy version`
- `frontend` depends on `api: service_healthy`; `caddy` depends on both `api: service_healthy` and `frontend: service_healthy`, which makes `docker compose up` deterministic (Caddy never starts before its upstreams are ready).

## Compose request flow

- Browser -> Caddy (`:80`) -> frontend/API.
- API -> Postgres (state + logs).
- API -> Docker socket (spawn/inspect containers).
- API -> Caddy Admin API (`http://caddy:2019`) for dynamic route updates.
- Caddy -> deployed app containers via shared Docker network.

## 6) Pipeline failure points and graceful handling

## Failure points

1. Invalid or inaccessible Git URL.
2. Git clone timeout/network failure.
3. Railpack missing/incompatible buildpack detection failure.
4. Build command exits non-zero.
5. Docker daemon unavailable/socket permission issue.
6. Container run starts but app never becomes healthy/listening.
7. Caddy Admin API update fails.
8. SSE clients disconnect mid-stream.
9. DB write failures while logging.

## Handling strategy

- Stage-based status transitions with strict updates:
  - `pending` -> `building` -> `deploying` -> `running|failed`.
- Structured error boundaries per stage:
  - Catch and annotate errors with stage context.
  - Persist error logs with `stderr`.
  - Emit terminal SSE `pipeline_failed` (custom name avoids collision with native `EventSource` `error`, which fires on transport errors and auto-reconnects).
- Command timeouts:
  - Clone/unzip/build each enforce a hard timeout and send `SIGTERM` followed by `SIGKILL` after a short grace period.
  - Timed-out commands still mark the deployment `failed` and emit `pipeline_failed`.
- Cleanup on failure:
  - Remove half-created containers.
  - Remove any Caddy route installed for the deployment (via the Admin API, under a process-local mutex so concurrent pipelines cannot clobber each other's route table).
  - Remove temp checkout directory.
- Concurrency safety:
  - Caddy route installs and removes are serialized through an in-process mutex; `putCaddyRoute` does a read-modify-write on `srv0/routes` and filters out any stale entry for the same deployment ID before inserting the new one.
- Observability:
  - Every major action emits logs (clone start/end, build start/end, run start/end, route create/remove).
- Idempotent delete:
  - `DELETE` succeeds even if container or route already absent (404 from Caddy Admin API is treated as success).
  - Deleted deployments transition to terminal status `deleted` and emit a final `pipeline_done` SSE event so any connected client observes a clean close.

## Implementation choices and rationale

- **TypeScript + Express API**: fast implementation, mature middleware ecosystem, easy SSE primitives.
- **Postgres over SQLite**: cleaner multi-connection behavior for concurrent log writes and read streams in containerized setup.
- **dockerode + child process hybrid**:
  - `dockerode` for inspect/stop/remove/network operations.
  - shell spawn for Railpack build command and optional `docker run` parity.
- **Path-based routing** (`/apps/{id}`): simplest local dev story (no wildcard DNS needed), aligns with single-ingress requirement.

