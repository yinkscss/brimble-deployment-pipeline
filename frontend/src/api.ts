import type { Build, Deployment } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

export async function createDeployment(gitUrl: string): Promise<Deployment> {
  const trimmed = gitUrl.trim();
  const res = await fetch(`${API_BASE}/deployments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ git_url: trimmed })
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createDeploymentFromUpload(file: File): Promise<Deployment> {
  const formData = new FormData();
  formData.append("project_file", file);
  const res = await fetch(`${API_BASE}/deployments`, {
    method: "POST",
    body: formData
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function listDeployments(): Promise<Deployment[]> {
  const res = await fetch(`${API_BASE}/deployments`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getDeployment(id: string): Promise<Deployment> {
  const res = await fetch(`${API_BASE}/deployments/${id}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteDeployment(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/deployments/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}

export async function listBuilds(id: string): Promise<Build[]> {
  const res = await fetch(`${API_BASE}/deployments/${id}/builds`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function rollbackDeployment(id: string, buildId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/deployments/${id}/rollback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ build_id: buildId })
  });
  if (!res.ok) throw new Error(await res.text());
}

export function logsSseUrl(id: string, cursor?: string | null): string {
  if (!cursor) return `${API_BASE}/deployments/${id}/logs`;
  const params = new URLSearchParams({ cursor });
  return `${API_BASE}/deployments/${id}/logs?${params.toString()}`;
}
