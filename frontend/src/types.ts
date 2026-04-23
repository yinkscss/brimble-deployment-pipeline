export type DeploymentStatus = "pending" | "building" | "deploying" | "running" | "failed" | "deleted";
export type BuildStatus = "building" | "succeeded" | "failed";
export type BuildSource = "git" | "upload" | "rollback";

export interface Deployment {
  id: string;
  git_url: string;
  status: DeploymentStatus;
  image_tag: string | null;
  container_id: string | null;
  caddy_route: string | null;
  active_build_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Build {
  id: string;
  deployment_id: string;
  image_tag: string;
  status: BuildStatus;
  source: BuildSource;
  parent_build_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LogEvent {
  id: string;
  line: string;
  stream: "stdout" | "stderr";
  timestamp: string;
}
