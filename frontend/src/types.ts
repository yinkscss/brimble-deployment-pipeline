export type DeploymentStatus = "pending" | "building" | "deploying" | "running" | "failed";

export interface Deployment {
  id: string;
  git_url: string;
  status: DeploymentStatus;
  image_tag: string | null;
  container_id: string | null;
  caddy_route: string | null;
  created_at: string;
  updated_at: string;
}

export interface LogEvent {
  line: string;
  stream: "stdout" | "stderr";
  timestamp: string;
}
