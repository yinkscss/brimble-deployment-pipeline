import { Pool } from "pg";
import type { Deployment, DeploymentStatus, LogLine, LogStream } from "./types.js";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

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
    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
      line TEXT NOT NULL,
      stream TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function createDeployment(id: string, gitUrl: string): Promise<Deployment> {
  const result = await pool.query(
    `
      INSERT INTO deployments (id, git_url, status)
      VALUES ($1, $2, 'pending')
      RETURNING id, git_url, status, image_tag, container_id, caddy_route, created_at::text, updated_at::text
    `,
    [id, gitUrl]
  );
  return result.rows[0] as Deployment;
}

export async function updateDeployment(
  id: string,
  patch: Partial<Pick<Deployment, "status" | "image_tag" | "container_id" | "caddy_route">>
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
  const result = await pool.query(`
    SELECT id, git_url, status, image_tag, container_id, caddy_route, created_at::text, updated_at::text
    FROM deployments
    ORDER BY created_at DESC
  `);
  return result.rows as Deployment[];
}

export async function getDeployment(id: string): Promise<Deployment | null> {
  const result = await pool.query(
    `
      SELECT id, git_url, status, image_tag, container_id, caddy_route, created_at::text, updated_at::text
      FROM deployments
      WHERE id = $1
    `,
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
      ORDER BY timestamp ASC
    `,
    [deploymentId]
  );
  return result.rows as LogLine[];
}

export async function setDeploymentStatus(id: string, status: DeploymentStatus): Promise<void> {
  await updateDeployment(id, { status });
}
