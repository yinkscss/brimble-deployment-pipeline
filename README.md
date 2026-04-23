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

- Single command startup via `docker compose up`
- Live log streaming over SSE (`GET /api/deployments/:id/logs`)
- Logs persisted in DB and replayed on reconnect
- Railpack-based image build (Railpack CLI in API container + BuildKit service)
- Caddy as single ingress for UI, API, and deployed apps
- Runtime readiness probe before marking deployment `running`

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

## API surface

- `POST /api/deployments` with either:
  - JSON body `{ "git_url": "https://..." }`
  - multipart form-data `project_file=<zip>`
- `GET /api/deployments`
- `GET /api/deployments/:id`
- `GET /api/deployments/:id/logs` (SSE)
- `DELETE /api/deployments/:id`

## Notes on deployed app expectations

- The app built by Railpack should listen on `PORT` (default `3000` in this project).
- The API currently infers exposed port from image metadata, with fallback behavior.
- API container installs Railpack with `curl -sSL https://railpack.com/install.sh | sh`.

## Brimble deployment + feedback

To complete submission requirements, add:

- Brimble deploy URL: `TODO`
- Honest feedback write-up: `TODO`

## Time spent / tradeoffs

- Time spent: `TODO`
- If I had another weekend:
  - support redeploy/rollback by reusing previous image tags
  - improve Caddy route bookkeeping with deterministic IDs
  - add integration tests for pipeline stages and SSE behavior

## Founder walkthrough talking points

- Why Caddy Admin API was chosen: mirrors control-plane behavior and keeps ingress dynamic without restarts.
- Why SSE over WebSocket: log streams are one-directional and SSE is operationally simpler through proxies.
- Why Postgres over SQLite in Compose: avoids file locking edge-cases under concurrent log writes + reads.
- Failure model: each pipeline stage emits logs, updates status, sends terminal SSE event, and does best-effort cleanup.
