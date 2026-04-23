import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createDeployment,
  createDeploymentFromUpload,
  deleteDeployment,
  getDeployment,
  listDeployments,
  logsSseUrl
} from "./api";
import type { Deployment, LogEvent } from "./types";

function badge(status: Deployment["status"]): string {
  switch (status) {
    case "running":
      return "badge badge-running";
    case "failed":
      return "badge badge-failed";
    case "building":
      return "badge badge-building";
    case "deploying":
      return "badge badge-deploying";
    default:
      return "badge badge-pending";
  }
}

const isTerminal = (status: Deployment["status"]) => status === "running" || status === "failed";

export function App() {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [gitUrl, setGitUrl] = useState("");
  const [projectFile, setProjectFile] = useState<File | null>(null);
  const [sourceMode, setSourceMode] = useState<"git" | "zip">("git");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [streamState, setStreamState] = useState<"idle" | "open" | "done" | "error">("idle");
  const [logFilter, setLogFilter] = useState<"all" | "stdout" | "stderr">("all");
  const [logQuery, setLogQuery] = useState("");
  const [logsPaused, setLogsPaused] = useState(false);

  const deploymentsQuery = useQuery({
    queryKey: ["deployments"],
    queryFn: listDeployments,
    refetchInterval: (q) => {
      const deployments = q.state.data ?? [];
      return deployments.some((d) => !isTerminal(d.status)) ? 3000 : false;
    }
  });

  const selectedDeployment = useMemo(
    () => deploymentsQuery.data?.find((d) => d.id === selectedId) ?? null,
    [deploymentsQuery.data, selectedId]
  );
  const deploymentStats = useMemo(() => {
    const deployments = deploymentsQuery.data ?? [];
    const active = deployments.filter((d) => !isTerminal(d.status)).length;
    const failed = deployments.filter((d) => d.status === "failed").length;
    const running = deployments.filter((d) => d.status === "running").length;
    const latest = deployments.length
      ? deployments
          .map((d) => d.created_at)
          .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
      : null;
    return { total: deployments.length, active, failed, running, latest };
  }, [deploymentsQuery.data]);
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (logFilter !== "all" && log.stream !== logFilter) return false;
      if (!logQuery.trim()) return true;
      return log.line.toLowerCase().includes(logQuery.toLowerCase());
    });
  }, [logFilter, logQuery, logs]);

  useQuery({
    queryKey: ["deployment", selectedId],
    queryFn: () => getDeployment(selectedId!),
    enabled: Boolean(selectedId),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status && !isTerminal(status) ? 3000 : false;
    }
  });

  const createMutation = useMutation({
    mutationFn: async (payload: { gitUrl?: string; file?: File | null }) => {
      if (payload.file) return createDeploymentFromUpload(payload.file);
      if (payload.gitUrl) return createDeployment(payload.gitUrl);
      throw new Error("Provide either git URL or zip file");
    },
    onSuccess: (deployment) => {
      setGitUrl("");
      setProjectFile(null);
      setSourceMode("git");
      setSelectedId(deployment.id);
      setLogs([]);
      setStreamState("idle");
      void qc.invalidateQueries({ queryKey: ["deployments"] });
    }
  });

  const deleteMutation = useMutation({
    mutationFn: deleteDeployment,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["deployments"] });
    }
  });

  useEffect(() => {
    if (!selectedId) return;

    setStreamState("open");
    const es = new EventSource(logsSseUrl(selectedId));
    es.onmessage = (event) => {
      if (logsPaused) return;
      try {
        const data = JSON.parse(event.data) as LogEvent;
        setLogs((prev) => [...prev, data]);
      } catch {
        // ignore malformed line
      }
    };
    es.addEventListener("done", () => {
      setStreamState("done");
      es.close();
      void qc.invalidateQueries({ queryKey: ["deployments"] });
    });
    es.addEventListener("error", () => {
      setStreamState("error");
      es.close();
      void qc.invalidateQueries({ queryKey: ["deployments"] });
    });
    return () => {
      es.close();
    };
  }, [logsPaused, qc, selectedId]);

  return (
    <main className="container">
      <header className="hero">
        <p className="hero-kicker">Ops Console</p>
        <h1 className="page-title">Brimble Deployment Pipeline</h1>
        <p className="hero-subtitle">
          Launch, monitor, and control deployments from a single premium command center.
        </p>
      </header>
      <section className="ops-snapshot" aria-label="Operational snapshot">
        <article className="snapshot-tile">
          <p>Total Deployments</p>
          <strong>{deploymentStats.total}</strong>
        </article>
        <article className="snapshot-tile">
          <p>Active Pipelines</p>
          <strong>{deploymentStats.active}</strong>
        </article>
        <article className="snapshot-tile">
          <p>Running</p>
          <strong>{deploymentStats.running}</strong>
        </article>
        <article className="snapshot-tile">
          <p>Failed</p>
          <strong>{deploymentStats.failed}</strong>
        </article>
        <article className="snapshot-tile">
          <p>Last Deploy</p>
          <strong>{deploymentStats.latest ? new Date(deploymentStats.latest).toLocaleString() : "N/A"}</strong>
        </article>
      </section>

      <section className="panel" aria-labelledby="new-deployment-heading" aria-busy={createMutation.isPending}>
        <div className="panel-header">
          <h2 id="new-deployment-heading" className="panel-title">
            New Deployment
          </h2>
          <p className="panel-note">Choose one source type. Selecting one disables the other field.</p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate({ gitUrl, file: projectFile });
          }}
          className="deploy-form"
        >
          <fieldset className="source-fieldset">
            <legend className="field-legend">Source</legend>
            <div className="mode-toggle" role="radiogroup" aria-label="Deployment source type">
              <button
                type="button"
                className={`mode-chip ${sourceMode === "git" ? "mode-chip-active" : ""}`}
                role="radio"
                aria-checked={sourceMode === "git"}
                onClick={() => {
                  setSourceMode("git");
                  setProjectFile(null);
                }}
              >
                Deploy from Git
              </button>
              <button
                type="button"
                className={`mode-chip ${sourceMode === "zip" ? "mode-chip-active" : ""}`}
                role="radio"
                aria-checked={sourceMode === "zip"}
                onClick={() => {
                  setSourceMode("zip");
                  setGitUrl("");
                }}
              >
                Deploy from ZIP
              </button>
            </div>
            {sourceMode === "git" ? (
              <div className="field">
                <label htmlFor="git-url">Repository URL</label>
                <input
                  id="git-url"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
                  aria-describedby="deploy-source-help"
                />
              </div>
            ) : (
              <div className="field">
                <label htmlFor="project-file">Project ZIP</label>
                <input
                  ref={fileInputRef}
                  id="project-file"
                  type="file"
                  accept=".zip"
                  className="hidden-file"
                  onChange={(e) => setProjectFile(e.target.files?.[0] ?? null)}
                  aria-describedby="deploy-source-help"
                />
                <div className="file-picker">
                  <button type="button" className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}>
                    Choose ZIP
                  </button>
                  <span className="file-name">{projectFile ? projectFile.name : "No file selected"}</span>
                </div>
              </div>
            )}
            <p id="deploy-source-help" className="field-help">
              Source mode keeps deployment intent explicit and reduces input ambiguity.
            </p>
          </fieldset>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={createMutation.isPending || (sourceMode === "git" ? !gitUrl.trim() : !projectFile)}
          >
            {createMutation.isPending ? "Creating..." : "Deploy"}
          </button>
        </form>
      </section>

      <section className="panel" aria-labelledby="deployments-heading">
        <div className="panel-header">
          <h2 id="deployments-heading" className="panel-title">
            Deployments
          </h2>
        </div>
        <div className="table-wrap" role="region" aria-label="Deployments table" tabIndex={0}>
          <table className="deployments-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Git URL</th>
                <th>Status</th>
                <th>Image Tag</th>
                <th>Live URL</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(deploymentsQuery.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty-state">
                      <p>No deployments yet.</p>
                      <span>Launch your first deployment above to populate this table.</span>
                    </div>
                  </td>
                </tr>
              ) : (
                (deploymentsQuery.data ?? []).map((d) => (
                  <tr key={d.id} className={`deployment-row ${selectedId === d.id ? "selected" : ""}`}>
                    <td>
                      <button
                        className="linkish id-pill"
                        onClick={() => setSelectedId(d.id)}
                        aria-current={selectedId === d.id ? "true" : undefined}
                      >
                        {d.id.slice(0, 8)}
                      </button>
                    </td>
                    <td className="truncate" title={d.git_url}>
                      {d.git_url}
                    </td>
                    <td>
                      <span className={badge(d.status)}>
                        <span className="badge-dot" aria-hidden="true" />
                        {d.status}
                      </span>
                    </td>
                    <td className="mono">{d.image_tag ?? "-"}</td>
                    <td className="truncate" title={d.caddy_route ?? undefined}>
                      {d.caddy_route ? (
                        <a href={d.caddy_route} target="_blank" rel="noopener noreferrer">
                          {new URL(d.caddy_route, window.location.origin).toString()}
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td>
                      <time dateTime={d.created_at}>{new Date(d.created_at).toLocaleString()}</time>
                    </td>
                    <td>
                      <button
                        className="btn btn-ghost"
                        onClick={() => deleteMutation.mutate(d.id)}
                        disabled={deleteMutation.isPending || !d.container_id}
                      >
                        Stop
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="log-viewer-heading">
        <div className="logs-header">
          <h2 id="log-viewer-heading" className="panel-title">
            Log Viewer {selectedDeployment ? `(${selectedDeployment.id.slice(0, 8)})` : ""}
          </h2>
          <div className="logs-toolbar">
            <input
              className="log-search"
              value={logQuery}
              onChange={(e) => setLogQuery(e.target.value)}
              placeholder="Search logs"
              aria-label="Search log lines"
            />
            <div className="chip-group" role="group" aria-label="Log stream filters">
              {(["all", "stdout", "stderr"] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={`chip ${logFilter === filter ? "chip-active" : ""}`}
                  onClick={() => setLogFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-ghost" onClick={() => setLogsPaused((v) => !v)}>
              {logsPaused ? "Resume" : "Pause"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setLogs([])}>
              Clear
            </button>
            <div className={`stream-status stream-${streamState}`} aria-live="polite">
              <span className="stream-dot" aria-hidden="true" />
              <span>Stream: {streamState}</span>
            </div>
          </div>
        </div>
        <div className="logs" role="log" aria-live="polite" aria-relevant="additions text" aria-atomic="false">
          {filteredLogs.length === 0 ? (
            <div className="empty-state">
              <p>No log entries match this view.</p>
              <span>Select a deployment and stream to inspect build and runtime output.</span>
            </div>
          ) : (
            filteredLogs.map((log, i) => (
              <pre key={`${log.timestamp}-${i}`} className={`log-line ${log.stream === "stderr" ? "stderr" : "stdout"}`}>
                <span className="mono">[{new Date(log.timestamp).toLocaleTimeString()}]</span> {log.stream} | {log.line}
              </pre>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
