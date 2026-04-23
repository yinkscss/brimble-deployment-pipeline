export type DeploymentStatus = "pending" | "building" | "deploying" | "running" | "failed" | "deleted";
export type LogStream = "stdout" | "stderr";

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

export interface LogLine {
  id: string;
  deployment_id: string;
  line: string;
  stream: LogStream;
  timestamp: string;
}
