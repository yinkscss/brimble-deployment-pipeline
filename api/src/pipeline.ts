import Docker from "dockerode";
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "ulid";
import {
  appendLog,
  createBuild,
  getBuild,
  getDeployment,
  setBuildStatus,
  setDeploymentStatus,
  updateDeployment
} from "./db.js";
import { publish, publishEvent } from "./logHub.js";
import type { BuildSource, LogStream } from "./types.js";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const CADDY_ADMIN_URL = process.env.CADDY_ADMIN_URL ?? "http://caddy:2019";
const APPS_BASE_PATH = process.env.APPS_BASE_PATH ?? "/apps";
const DOCKER_NETWORK = process.env.DOCKER_NETWORK ?? "brimble-platform";
const READINESS_TIMEOUT_MS = 120000;
const CLONE_TIMEOUT_MS = Number(process.env.CLONE_TIMEOUT_MS ?? "180000");
const UNZIP_TIMEOUT_MS = Number(process.env.UNZIP_TIMEOUT_MS ?? "120000");
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS ?? "1200000");
const COMMAND_KILL_GRACE_MS = 5000;
const READINESS_PROBE_TIMEOUT_MS = Number(process.env.READINESS_PROBE_TIMEOUT_MS ?? "3000");
const GRACEFUL_STOP_TIMEOUT_S = Number(process.env.GRACEFUL_STOP_TIMEOUT_S ?? "10");

let caddyMutationLock: Promise<void> = Promise.resolve();

async function withCaddyMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  const pending = caddyMutationLock;
  let release: () => void = () => {};
  caddyMutationLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await pending;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function addLog(deploymentId: string, line: string, stream: LogStream): Promise<void> {
  const log = await appendLog(ulid(), deploymentId, line, stream);
  publish(deploymentId, {
    id: log.id,
    line: log.line,
    stream: log.stream,
    timestamp: log.timestamp
  });
}

async function collectLines(
  deploymentId: string,
  stream: LogStream,
  chunk: Buffer,
  remainderRef: { value: string }
): Promise<void> {
  const content = remainderRef.value + chunk.toString("utf8");
  const lines = content.split("\n");
  remainderRef.value = lines.pop() ?? "";
  for (const line of lines.filter(Boolean)) {
    await addLog(deploymentId, line, stream);
  }
}

type RunCommandOptions = {
  cwd?: string;
  timeoutMs?: number;
};

async function runCommand(
  deploymentId: string,
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<void> {
  const { cwd, timeoutMs } = options;
  await addLog(deploymentId, `$ ${command} ${args.join(" ")}`, "stdout");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, { cwd });
    const stdoutRemainder = { value: "" };
    const stderrRemainder = { value: "" };
    const pendingWrites = new Set<Promise<void>>();
    let settled = false;
    let timedOut = false;

    const track = (promise: Promise<void>): void => {
      pendingWrites.add(promise);
      void promise.finally(() => {
        pendingWrites.delete(promise);
      });
    };

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timeoutHandle =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            void addLog(
              deploymentId,
              `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}`,
              "stderr"
            );
            proc.kill("SIGTERM");
            setTimeout(() => {
              if (!proc.killed) proc.kill("SIGKILL");
            }, COMMAND_KILL_GRACE_MS);
          }, timeoutMs)
        : null;

    proc.stdout.on("data", (chunk: Buffer) => {
      track(collectLines(deploymentId, "stdout", chunk, stdoutRemainder));
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      track(collectLines(deploymentId, "stderr", chunk, stderrRemainder));
    });
    proc.on("error", (error) => settle(() => reject(error)));
    proc.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (stdoutRemainder.value.trim()) track(addLog(deploymentId, stdoutRemainder.value, "stdout"));
      if (stderrRemainder.value.trim()) track(addLog(deploymentId, stderrRemainder.value, "stderr"));
      void Promise.all(Array.from(pendingWrites)).then(() => {
        settle(() => {
          if (timedOut) reject(new Error(`Command timed out (${command})`));
          else if (code === 0) resolve();
          else reject(new Error(`Command failed (${command}) with code ${code}`));
        });
      });
    });
  });
}

async function putCaddyRoute(
  deploymentId: string,
  upstreamHost: string,
  upstreamPort: number
): Promise<string> {
  return withCaddyMutationLock(async () => {
    const route = `${APPS_BASE_PATH}/${deploymentId}`;
    const routeId = `app-${deploymentId}`;
    const payload = {
      "@id": routeId,
      match: [{ path: [route, `${route}/*`] }],
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

    const routes = await readCaddyRoutes();
    const insertionIndex = getAppRouteInsertionIndex(routes);
    const nextRoutes = [...routes.filter((entry) => entry["@id"] !== routeId)];
    nextRoutes.splice(insertionIndex, 0, payload);

    const res = await fetch(`${CADDY_ADMIN_URL}/config/apps/http/servers/srv0/routes`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextRoutes)
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to configure Caddy route: ${res.status} ${body}`);
    }
    return route;
  });
}

type CaddyRoute = { "@id"?: string; match?: Array<{ path?: string[] }> };

async function readCaddyRoutes(): Promise<CaddyRoute[]> {
  const res = await fetch(`${CADDY_ADMIN_URL}/config/apps/http/servers/srv0/routes`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to read Caddy routes: ${res.status} ${body}`);
  }
  return (await res.json()) as CaddyRoute[];
}

function getAppRouteInsertionIndex(routes: CaddyRoute[]): number {
  const catchAllIndex = routes.findIndex((entry) => !entry.match || entry.match.length === 0);
  if (catchAllIndex === -1) return routes.length;
  return catchAllIndex;
}

export async function removeCaddyRouteByPath(caddyRoute: string): Promise<void> {
  const deploymentId = caddyRoute.split("/").filter(Boolean).at(-1);
  if (!deploymentId) return;
  await withCaddyMutationLock(async () => {
    const res = await fetch(`${CADDY_ADMIN_URL}/id/app-${deploymentId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      const body = await res.text();
      throw new Error(`Failed to remove Caddy route: ${res.status} ${body}`);
    }
  });
}

function shortBuildId(buildId: string): string {
  return buildId.slice(-10).toLowerCase();
}

function containerNameFor(deploymentId: string, buildId: string): string {
  return `app-${deploymentId.toLowerCase()}-${shortBuildId(buildId)}`;
}

function imageTagFor(deploymentId: string, buildId: string): string {
  return `deployment-${deploymentId.toLowerCase()}:${buildId.toLowerCase()}`;
}

async function gracefulDestroyContainer(containerId: string): Promise<void> {
  const c = docker.getContainer(containerId);
  try {
    await c.stop({ t: GRACEFUL_STOP_TIMEOUT_S });
  } catch {
    // ignore: may already be stopped or removed
  }
  try {
    await c.remove({ force: true });
  } catch {
    // ignore: idempotent removal
  }
}

export async function processDeployment(deploymentId: string, gitUrl: string): Promise<void> {
  const workdir = join("/app/tmp", deploymentId);
  await mkdir(workdir, { recursive: true });
  try {
    await runCommand(deploymentId, "git", ["clone", "--depth", "1", gitUrl, workdir], {
      timeoutMs: CLONE_TIMEOUT_MS
    });
    await runBuildAndDeploy(deploymentId, workdir, "git");
  } catch (error) {
    await setDeploymentStatus(deploymentId, "failed");
    await addLog(deploymentId, error instanceof Error ? error.message : String(error), "stderr");
    publishEvent(deploymentId, "pipeline_failed", {
      status: "failed",
      message: error instanceof Error ? error.message : "Unknown pipeline error"
    });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function processUploadedDeployment(deploymentId: string, archivePath: string): Promise<void> {
  const workdir = join("/app/tmp", deploymentId);
  await mkdir(workdir, { recursive: true });
  try {
    await runCommand(deploymentId, "unzip", ["-q", archivePath, "-d", workdir], {
      timeoutMs: UNZIP_TIMEOUT_MS
    });
    const projectDir = await resolveProjectDirectory(workdir);
    if (projectDir !== workdir) {
      await addLog(deploymentId, `Detected nested project root: ${projectDir}`, "stdout");
    }
    await runBuildAndDeploy(deploymentId, projectDir, "upload");
  } catch (error) {
    await setDeploymentStatus(deploymentId, "failed");
    await addLog(deploymentId, error instanceof Error ? error.message : String(error), "stderr");
    publishEvent(deploymentId, "pipeline_failed", {
      status: "failed",
      message: error instanceof Error ? error.message : "Unknown pipeline error"
    });
  } finally {
    await rm(archivePath, { force: true });
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
      const res = await fetch(`http://${upstreamHost}:${upstreamPort}/`, {
        signal: AbortSignal.timeout(READINESS_PROBE_TIMEOUT_MS)
      });
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

async function runBuildAndDeploy(
  deploymentId: string,
  workdir: string,
  source: Exclude<BuildSource, "rollback">
): Promise<void> {
  const buildId = ulid();
  const imageTag = imageTagFor(deploymentId, buildId);
  const buildRow = await createBuild(buildId, deploymentId, imageTag, source, null);
  try {
    await setDeploymentStatus(deploymentId, "building");
    await addLog(deploymentId, `Build ${buildRow.id} started (image ${imageTag})`, "stdout");
    await runCommand(deploymentId, "railpack", ["build", "--name", imageTag, "--progress", "plain", workdir], {
      timeoutMs: BUILD_TIMEOUT_MS
    });
    await setBuildStatus(buildRow.id, "succeeded");
    await addLog(deploymentId, `Build ${buildRow.id} succeeded`, "stdout");
    await swapToBuild(deploymentId, buildRow.id, imageTag);
  } catch (error) {
    await setBuildStatus(buildRow.id, "failed");
    throw error;
  }
}

async function swapToBuild(deploymentId: string, buildId: string, imageTag: string): Promise<void> {
  const previous = await getDeployment(deploymentId);
  const previousContainerId = previous?.container_id ?? null;

  await setDeploymentStatus(deploymentId, "deploying");
  await addLog(deploymentId, `Swapping deployment to build ${buildId} (${imageTag})`, "stdout");

  const containerName = containerNameFor(deploymentId, buildId);
  let container: Docker.Container | null = null;
  try {
    container = await docker.createContainer({
      Image: imageTag,
      name: containerName,
      HostConfig: {
        NetworkMode: DOCKER_NETWORK,
        RestartPolicy: { Name: "unless-stopped" }
      },
      Env: ["PORT=3000"]
    });
    await container.start();
    await addLog(deploymentId, `Container ${containerName} started (${container.id})`, "stdout");

    const inspect = await container.inspect();
    const port = Number(Object.keys(inspect.Config.ExposedPorts ?? {}).at(0)?.split("/")[0] ?? "3000");
    await waitForAppReadiness(deploymentId, containerName, port);

    const caddyRoute = await putCaddyRoute(deploymentId, containerName, port);
    await addLog(deploymentId, `Caddy route swapped to ${containerName}:${port}`, "stdout");

    await updateDeployment(deploymentId, {
      status: "running",
      image_tag: imageTag,
      container_id: container.id,
      caddy_route: caddyRoute,
      active_build_id: buildId
    });

    if (previousContainerId && previousContainerId !== container.id) {
      await addLog(deploymentId, `Gracefully stopping previous container ${previousContainerId}`, "stdout");
      await gracefulDestroyContainer(previousContainerId);
      await addLog(deploymentId, `Previous container ${previousContainerId} removed`, "stdout");
    }

    publishEvent(deploymentId, "pipeline_done", { status: "running", caddy_route: caddyRoute });
  } catch (error) {
    await setDeploymentStatus(deploymentId, "failed");
    await addLog(deploymentId, error instanceof Error ? error.message : String(error), "stderr");
    if (container) {
      try {
        await gracefulDestroyContainer(container.id);
      } catch {
        // best-effort cleanup
      }
    }
    publishEvent(deploymentId, "pipeline_failed", {
      status: "failed",
      message: error instanceof Error ? error.message : "Unknown pipeline error"
    });
    throw error;
  }
}

export async function processRollback(deploymentId: string, targetBuildId: string): Promise<void> {
  const build = await getBuild(targetBuildId);
  if (!build || build.deployment_id !== deploymentId) {
    throw new Error(`Build ${targetBuildId} not found for deployment ${deploymentId}`);
  }
  if (build.status !== "succeeded") {
    throw new Error(`Build ${targetBuildId} is not in 'succeeded' state (status=${build.status})`);
  }

  const rollbackBuildId = ulid();
  const rollbackBuildRow = await createBuild(
    rollbackBuildId,
    deploymentId,
    build.image_tag,
    "rollback",
    build.id
  );
  try {
    await addLog(
      deploymentId,
      `Rollback requested: redeploying build ${build.id} (${build.image_tag}) as ${rollbackBuildId}`,
      "stdout"
    );
    await swapToBuild(deploymentId, rollbackBuildId, build.image_tag);
    await setBuildStatus(rollbackBuildRow.id, "succeeded");
  } catch (error) {
    await setBuildStatus(rollbackBuildRow.id, "failed");
    throw error;
  }
}

export async function destroyContainer(containerId: string): Promise<void> {
  await gracefulDestroyContainer(containerId);
}
