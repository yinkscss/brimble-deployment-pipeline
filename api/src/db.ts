import { Pool } from "pg";
import type { Build, BuildSource, BuildStatus, Deployment, DeploymentStatus, LogLine, LogStream } from "./types.js";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const DEPLOYMENT_COLUMNS = `
  id, git_url, status, image_tag, container_id, caddy_route,
  active_build_id, created_at::text, updated_at::text
`;

const BUILD_COLUMNS = `
  id, deployment_id, image_tag, status, source,
  parent_build_id, created_at::text, updated_at::text
`;

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      git_url TEXT NOT NULL,
      status TEXT NOT NULL,
      image_tag TEXT,
      container_id TEXT,
      caddy_route TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE deployments
    ADD COLUMN IF NOT EXISTS active_build_id TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
      line TEXT NOT NULL,
      stream TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS builds (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
      image_tag TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      parent_build_id TEXT REFERENCES builds(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS builds_deployment_id_idx ON builds(deployment_id);
  `);
}

export async function createDeployment(id: string, gitUrl: string): Promise<Deployment> {
  const result = await pool.query(
    `
      INSERT INTO deployments (id, git_url, status)
      VALUES ($1, $2, 'pending')
      RETURNING ${DEPLOYMENT_COLUMNS}
    `,
    [id, gitUrl]
  );
  return result.rows[0] as Deployment;
}

export async function updateDeployment(
  id: string,
  patch: Partial<Pick<Deployment, "status" | "image_tag" | "container_id" | "caddy_route" | "active_build_id">>
): Promise<void> {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (!keys.length) return;
  const setClause = keys.map((key, idx) => `${key} = $${idx + 2}`).join(", ");
  const values = keys.map((key) => patch[key]);
  await pool.query(
    `UPDATE deployments SET ${setClause}, updated_at = NOW() WHERE id = $1`,
    [id, ...values]
  );
}

export async function listDeployments(): Promise<Deployment[]> {
  const result = await pool.query(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments ORDER BY created_at DESC`
  );
  return result.rows as Deployment[];
}

export async function getDeployment(id: string): Promise<Deployment | null> {
  const result = await pool.query(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = $1`,
    [id]
  );
  return (result.rows[0] as Deployment) ?? null;
}

export async function appendLog(
  id: string,
  deploymentId: string,
  line: string,
  stream: LogStream
): Promise<LogLine> {
  const result = await pool.query(
    `
      INSERT INTO logs (id, deployment_id, line, stream)
      VALUES ($1, $2, $3, $4)
      RETURNING id, deployment_id, line, stream, timestamp::text
    `,
    [id, deploymentId, line, stream]
  );
  return result.rows[0] as LogLine;
}

export async function getLogs(deploymentId: string): Promise<LogLine[]> {
  const result = await pool.query(
    `
      SELECT id, deployment_id, line, stream, timestamp::text
      FROM logs
      WHERE deployment_id = $1
      ORDER BY id ASC
    `,
    [deploymentId]
  );
  return result.rows as LogLine[];
}

export async function getLogsAfter(deploymentId: string, afterId: string): Promise<LogLine[]> {
  const result = await pool.query(
    `
      SELECT id, deployment_id, line, stream, timestamp::text
      FROM logs
      WHERE deployment_id = $1 AND id > $2
      ORDER BY id ASC
    `,
    [deploymentId, afterId]
  );
  return result.rows as LogLine[];
}

export async function setDeploymentStatus(id: string, status: DeploymentStatus): Promise<void> {
  await updateDeployment(id, { status });
}

export async function createBuild(
  id: string,
  deploymentId: string,
  imageTag: string,
  source: BuildSource,
  parentBuildId: string | null
): Promise<Build> {
  const result = await pool.query(
    `
      INSERT INTO builds (id, deployment_id, image_tag, status, source, parent_build_id)
      VALUES ($1, $2, $3, 'building', $4, $5)
      RETURNING ${BUILD_COLUMNS}
    `,
    [id, deploymentId, imageTag, source, parentBuildId]
  );
  return result.rows[0] as Build;
}

export async function setBuildStatus(id: string, status: BuildStatus): Promise<void> {
  await pool.query(
    `UPDATE builds SET status = $2, updated_at = NOW() WHERE id = $1`,
    [id, status]
  );
}

export async function listBuilds(deploymentId: string): Promise<Build[]> {
  const result = await pool.query(
    `SELECT ${BUILD_COLUMNS} FROM builds WHERE deployment_id = $1 ORDER BY created_at DESC`,
    [deploymentId]
  );
  return result.rows as Build[];
}

export async function getBuild(id: string): Promise<Build | null> {
  const result = await pool.query(
    `SELECT ${BUILD_COLUMNS} FROM builds WHERE id = $1`,
    [id]
  );
  return (result.rows[0] as Build) ?? null;
}
