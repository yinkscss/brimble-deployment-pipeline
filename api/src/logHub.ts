import type { Response } from "express";
import type { LogLine } from "./types.js";

type Client = Response;

const clients = new Map<string, Set<Client>>();

export function subscribe(deploymentId: string, res: Response): void {
  const set = clients.get(deploymentId) ?? new Set<Response>();
  set.add(res);
  clients.set(deploymentId, set);
}

export function unsubscribe(deploymentId: string, res: Response): void {
  const set = clients.get(deploymentId);
  if (!set) return;
  set.delete(res);
  if (!set.size) clients.delete(deploymentId);
}

export function publish(deploymentId: string, payload: Pick<LogLine, "id" | "line" | "stream" | "timestamp">): void {
  const set = clients.get(deploymentId);
  if (!set) return;
  const message = `id: ${payload.id}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of set) client.write(message);
}

export function publishEvent(deploymentId: string, event: string, payload: unknown): void {
  const set = clients.get(deploymentId);
  if (!set) return;
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of set) client.write(message);
}
