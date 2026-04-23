import Docker from "dockerode";
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "ulid";
import { appendLog, setDeploymentStatus, updateDeployment } from "./db.js";
import { publish, publishEvent } from "./logHub.js";
import type { LogStream } from "./types.js";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const CADDY_ADMIN_URL = process.env.CADDY_ADMIN_URL ?? "http://caddy:2019";
const APPS_BASE_PATH = process.env.APPS_BASE_PATH ?? "/apps";
const DOCKER_NETWORK = process.env.DOCKER_NETWORK ?? "job-application_platform";
const READINESS_TIMEOUT_MS = 120000;

async function addLog(deploymentId: string, line: string, stream: LogStream): Promise<void> {
  const log = await appendLog(ulid(), deploymentId, line, stream);
  publish(deploymentId, {
    line: log.line,
    stream: log.stream,
    timestamp: log.timestamp
  });
}

function collectLines(
  deploymentId: string,
  stream: LogStream,
  chunk: Buffer,
  remainderRef: { value: string }
): void {
  const content = remainderRef.value + chunk.toString("utf8");
  const lines = content.split("\n");
  remainderRef.value = lines.pop() ?? "";
  void Promise.all(lines.filter(Boolean).map((line) => addLog(deploymentId, line, stream)));
}

async function runCommand(
  deploymentId: string,
  command: string,
  args: string[],
  cwd?: string
): Promise<void> {
  await addLog(deploymentId, `$ ${command} ${args.join(" ")}`, "stdout");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, { cwd });
    const stdoutRemainder = { value: "" };
    const stderrRemainder = { value: "" };

    proc.stdout.on("data", (chunk) => collectLines(deploymentId, "stdout", chunk, stdoutRemainder));
    proc.stderr.on("data", (chunk) => collectLines(deploymentId, "stderr", chunk, stderrRemainder));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (stdoutRemainder.value.trim()) void addLog(deploymentId, stdoutRemainder.value, "stdout");
      if (stderrRemainder.value.trim()) void addLog(deploymentId, stderrRemainder.value, "stderr");
      if (code === 0) resolve();
      else reject(new Error(`Command failed (${command}) with code ${code}`));
    });
  });
}

async function putCaddyRoute(deploymentId: string, upstreamHost: string, upstreamPort: number): Promise<string> {
  const route = `${APPS_BASE_PATH}/${deploymentId}`;
  const payload = {
    match: [{ path: [`${route}/*`] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            handle: [
              {
                handler: "rewrite",
                strip_path_prefix: route
              }
            ]
          },
          {
            handle: [
              {
                handler: "reverse_proxy",
                upstreams: [{ dial: `${upstreamHost}:${upstreamPort}` }]
              }
            ]
          }
        ]
      }
    ]
  };

  const res = await fetch(`${CADDY_ADMIN_URL}/config/apps/http/servers/srv0/routes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to configure Caddy route: ${res.status} ${body}`);
  }
  return route;
}

export async function removeCaddyRouteByPath(caddyRoute: string): Promise<void> {
  const res = await fetch(`${CADDY_ADMIN_URL}/config/apps/http/servers/srv0/routes`);
  if (!res.ok) return;
  const routes = (await res.json()) as unknown[];
  const idx = routes.findIndex((route) => {
    if (!route || typeof route !== "object") return false;
    const record = route as { match?: Array<{ path?: string[] }> };
    return record.match?.some((m) => m.path?.some((p) => p.startsWith(`${caddyRoute}/`)));
  });
  if (idx < 0) return;
  await fetch(`${CADDY_ADMIN_URL}/config/apps/http/servers/srv0/routes/${idx}`, {
    method: "DELETE"
  });
}

export async function processDeployment(deploymentId: string, gitUrl: string): Promise<void> {
  const workdir = join("/app/tmp", deploymentId);
  await mkdir(workdir, { recursive: true });
  try {
    await runCommand(deploymentId, "git", ["clone", "--depth", "1", gitUrl, workdir]);
    await runPipelineFromDirectory(deploymentId, workdir);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function processUploadedDeployment(deploymentId: string, archivePath: string): Promise<void> {
  const workdir = join("/app/tmp", deploymentId);
  await mkdir(workdir, { recursive: true });
  try {
    await runCommand(deploymentId, "unzip", ["-q", archivePath, "-d", workdir]);
    const projectDir = await resolveProjectDirectory(workdir);
    if (projectDir !== workdir) {
      await addLog(deploymentId, `Detected nested project root: ${projectDir}`, "stdout");
    }
    await runPipelineFromDirectory(deploymentId, projectDir);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function resolveProjectDirectory(workdir: string): Promise<string> {
  const children = (await readdir(workdir, { withFileTypes: true })).filter(
    (entry) => entry.name !== "__MACOSX" && entry.name !== ".DS_Store"
  );

  if (children.length === 1 && children[0].isDirectory()) {
    return join(workdir, children[0].name);
  }
  return workdir;
}

async function waitForAppReadiness(
  deploymentId: string,
  upstreamHost: string,
  upstreamPort: number
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < READINESS_TIMEOUT_MS) {
    try {
      const res = await fetch(`http://${upstreamHost}:${upstreamPort}/`);
      if (res.ok || res.status < 500) {
        await addLog(deploymentId, `Readiness check passed: http://${upstreamHost}:${upstreamPort}/`, "stdout");
        return;
      }
      await addLog(deploymentId, `Readiness probe status ${res.status}, retrying...`, "stderr");
    } catch {
      await addLog(deploymentId, `Readiness probe connection failed, retrying...`, "stderr");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for app readiness after ${READINESS_TIMEOUT_MS / 1000}s`);
}

async function runPipelineFromDirectory(deploymentId: string, workdir: string): Promise<void> {
  const imageTag = `deployment-${deploymentId.toLowerCase()}:latest`;
  let containerId: string | null = null;
  try {
    await setDeploymentStatus(deploymentId, "building");
    await runCommand(deploymentId, "railpack", ["build", "--name", imageTag, "--progress", "plain", workdir]);
    await updateDeployment(deploymentId, { image_tag: imageTag, status: "deploying" });

    const container = await docker.createContainer({
      Image: imageTag,
      name: `app-${deploymentId}`,
      HostConfig: { NetworkMode: DOCKER_NETWORK },
      Env: ["PORT=3000"]
    });
    await container.start();
    containerId = container.id;
    await addLog(deploymentId, `Container started: ${containerId}`, "stdout");

    const inspect = await container.inspect();
    const port = Number(Object.keys(inspect.Config.ExposedPorts ?? {}).at(0)?.split("/")[0] ?? "3000");
    const upstreamHost = `app-${deploymentId}`;
    await waitForAppReadiness(deploymentId, upstreamHost, port);

    const caddyRoute = await putCaddyRoute(deploymentId, upstreamHost, port);
    await updateDeployment(deploymentId, { status: "running", container_id: containerId, caddy_route: caddyRoute });
    publishEvent(deploymentId, "done", { status: "running", caddy_route: caddyRoute });
  } catch (error) {
    await setDeploymentStatus(deploymentId, "failed");
    await addLog(deploymentId, error instanceof Error ? error.message : String(error), "stderr");
    if (containerId) {
      try {
        const c = docker.getContainer(containerId);
        await c.stop({ t: 2 });
        await c.remove({ force: true });
      } catch {
        // best-effort cleanup
      }
    }
    publishEvent(deploymentId, "error", {
      message: error instanceof Error ? error.message : "Unknown pipeline error"
    });
  }
}

export async function destroyContainer(containerId: string): Promise<void> {
  const c = docker.getContainer(containerId);
  try {
    await c.stop({ t: 2 });
  } catch {
    // ignored
  }
  await c.remove({ force: true });
}
