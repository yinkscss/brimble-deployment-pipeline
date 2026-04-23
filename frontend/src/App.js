import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createDeployment, createDeploymentFromUpload, deleteDeployment, getDeployment, listDeployments, logsSseUrl } from "./api";
function badge(status) {
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
const isTerminal = (status) => status === "running" || status === "failed";
export function App() {
    const qc = useQueryClient();
    const fileInputRef = useRef(null);
    const [gitUrl, setGitUrl] = useState("");
    const [projectFile, setProjectFile] = useState(null);
    const [sourceMode, setSourceMode] = useState("git");
    const [selectedId, setSelectedId] = useState(null);
    const [logs, setLogs] = useState([]);
    const [streamState, setStreamState] = useState("idle");
    const [logFilter, setLogFilter] = useState("all");
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
    const selectedDeployment = useMemo(() => deploymentsQuery.data?.find((d) => d.id === selectedId) ?? null, [deploymentsQuery.data, selectedId]);
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
            if (logFilter !== "all" && log.stream !== logFilter)
                return false;
            if (!logQuery.trim())
                return true;
            return log.line.toLowerCase().includes(logQuery.toLowerCase());
        });
    }, [logFilter, logQuery, logs]);
    useQuery({
        queryKey: ["deployment", selectedId],
        queryFn: () => getDeployment(selectedId),
        enabled: Boolean(selectedId),
        refetchInterval: (q) => {
            const status = q.state.data?.status;
            return status && !isTerminal(status) ? 3000 : false;
        }
    });
    const createMutation = useMutation({
        mutationFn: async (payload) => {
            if (payload.file)
                return createDeploymentFromUpload(payload.file);
            if (payload.gitUrl)
                return createDeployment(payload.gitUrl);
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
        if (!selectedId)
            return;
        setStreamState("open");
        const es = new EventSource(logsSseUrl(selectedId));
        es.onmessage = (event) => {
            if (logsPaused)
                return;
            try {
                const data = JSON.parse(event.data);
                setLogs((prev) => [...prev, data]);
            }
            catch {
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
    return (_jsxs("main", { className: "container", children: [_jsxs("header", { className: "hero", children: [_jsx("p", { className: "hero-kicker", children: "Ops Console" }), _jsx("h1", { className: "page-title", children: "Brimble Deployment Pipeline" }), _jsx("p", { className: "hero-subtitle", children: "Launch, monitor, and control deployments from a single premium command center." })] }), _jsxs("section", { className: "ops-snapshot", "aria-label": "Operational snapshot", children: [_jsxs("article", { className: "snapshot-tile", children: [_jsx("p", { children: "Total Deployments" }), _jsx("strong", { children: deploymentStats.total })] }), _jsxs("article", { className: "snapshot-tile", children: [_jsx("p", { children: "Active Pipelines" }), _jsx("strong", { children: deploymentStats.active })] }), _jsxs("article", { className: "snapshot-tile", children: [_jsx("p", { children: "Running" }), _jsx("strong", { children: deploymentStats.running })] }), _jsxs("article", { className: "snapshot-tile", children: [_jsx("p", { children: "Failed" }), _jsx("strong", { children: deploymentStats.failed })] }), _jsxs("article", { className: "snapshot-tile", children: [_jsx("p", { children: "Last Deploy" }), _jsx("strong", { children: deploymentStats.latest ? new Date(deploymentStats.latest).toLocaleString() : "N/A" })] })] }), _jsxs("section", { className: "panel", "aria-labelledby": "new-deployment-heading", "aria-busy": createMutation.isPending, children: [_jsxs("div", { className: "panel-header", children: [_jsx("h2", { id: "new-deployment-heading", className: "panel-title", children: "New Deployment" }), _jsx("p", { className: "panel-note", children: "Choose one source type. Selecting one disables the other field." })] }), _jsxs("form", { onSubmit: (e) => {
                            e.preventDefault();
                            createMutation.mutate({ gitUrl, file: projectFile });
                        }, className: "deploy-form", children: [_jsxs("fieldset", { className: "source-fieldset", children: [_jsx("legend", { className: "field-legend", children: "Source" }), _jsxs("div", { className: "mode-toggle", role: "radiogroup", "aria-label": "Deployment source type", children: [_jsx("button", { type: "button", className: `mode-chip ${sourceMode === "git" ? "mode-chip-active" : ""}`, role: "radio", "aria-checked": sourceMode === "git", onClick: () => {
                                                    setSourceMode("git");
                                                    setProjectFile(null);
                                                }, children: "Deploy from Git" }), _jsx("button", { type: "button", className: `mode-chip ${sourceMode === "zip" ? "mode-chip-active" : ""}`, role: "radio", "aria-checked": sourceMode === "zip", onClick: () => {
                                                    setSourceMode("zip");
                                                    setGitUrl("");
                                                }, children: "Deploy from ZIP" })] }), sourceMode === "git" ? (_jsxs("div", { className: "field", children: [_jsx("label", { htmlFor: "git-url", children: "Repository URL" }), _jsx("input", { id: "git-url", value: gitUrl, onChange: (e) => setGitUrl(e.target.value), placeholder: "https://github.com/user/repo.git", "aria-describedby": "deploy-source-help" })] })) : (_jsxs("div", { className: "field", children: [_jsx("label", { htmlFor: "project-file", children: "Project ZIP" }), _jsx("input", { ref: fileInputRef, id: "project-file", type: "file", accept: ".zip", className: "hidden-file", onChange: (e) => setProjectFile(e.target.files?.[0] ?? null), "aria-describedby": "deploy-source-help" }), _jsxs("div", { className: "file-picker", children: [_jsx("button", { type: "button", className: "btn btn-ghost", onClick: () => fileInputRef.current?.click(), children: "Choose ZIP" }), _jsx("span", { className: "file-name", children: projectFile ? projectFile.name : "No file selected" })] })] })), _jsx("p", { id: "deploy-source-help", className: "field-help", children: "Source mode keeps deployment intent explicit and reduces input ambiguity." })] }), _jsx("button", { className: "btn btn-primary", type: "submit", disabled: createMutation.isPending || (sourceMode === "git" ? !gitUrl.trim() : !projectFile), children: createMutation.isPending ? "Creating..." : "Deploy" })] })] }), _jsxs("section", { className: "panel", "aria-labelledby": "deployments-heading", children: [_jsx("div", { className: "panel-header", children: _jsx("h2", { id: "deployments-heading", className: "panel-title", children: "Deployments" }) }), _jsx("div", { className: "table-wrap", role: "region", "aria-label": "Deployments table", tabIndex: 0, children: _jsxs("table", { className: "deployments-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "ID" }), _jsx("th", { children: "Git URL" }), _jsx("th", { children: "Status" }), _jsx("th", { children: "Image Tag" }), _jsx("th", { children: "Live URL" }), _jsx("th", { children: "Created" }), _jsx("th", { children: "Actions" })] }) }), _jsx("tbody", { children: (deploymentsQuery.data ?? []).length === 0 ? (_jsx("tr", { children: _jsx("td", { colSpan: 7, children: _jsxs("div", { className: "empty-state", children: [_jsx("p", { children: "No deployments yet." }), _jsx("span", { children: "Launch your first deployment above to populate this table." })] }) }) })) : ((deploymentsQuery.data ?? []).map((d) => (_jsxs("tr", { className: `deployment-row ${selectedId === d.id ? "selected" : ""}`, children: [_jsx("td", { children: _jsx("button", { className: "linkish id-pill", onClick: () => setSelectedId(d.id), "aria-current": selectedId === d.id ? "true" : undefined, children: d.id.slice(0, 8) }) }), _jsx("td", { className: "truncate", title: d.git_url, children: d.git_url }), _jsx("td", { children: _jsxs("span", { className: badge(d.status), children: [_jsx("span", { className: "badge-dot", "aria-hidden": "true" }), d.status] }) }), _jsx("td", { className: "mono", children: d.image_tag ?? "-" }), _jsx("td", { className: "truncate", title: d.caddy_route ?? undefined, children: d.caddy_route ? (_jsx("a", { href: d.caddy_route, target: "_blank", rel: "noopener noreferrer", children: d.caddy_route })) : ("-") }), _jsx("td", { children: _jsx("time", { dateTime: d.created_at, children: new Date(d.created_at).toLocaleString() }) }), _jsx("td", { children: _jsx("button", { className: "btn btn-ghost", onClick: () => deleteMutation.mutate(d.id), disabled: deleteMutation.isPending || !d.container_id, children: "Stop" }) })] }, d.id)))) })] }) })] }), _jsxs("section", { className: "panel", "aria-labelledby": "log-viewer-heading", children: [_jsxs("div", { className: "logs-header", children: [_jsxs("h2", { id: "log-viewer-heading", className: "panel-title", children: ["Log Viewer ", selectedDeployment ? `(${selectedDeployment.id.slice(0, 8)})` : ""] }), _jsxs("div", { className: "logs-toolbar", children: [_jsx("input", { className: "log-search", value: logQuery, onChange: (e) => setLogQuery(e.target.value), placeholder: "Search logs", "aria-label": "Search log lines" }), _jsx("div", { className: "chip-group", role: "group", "aria-label": "Log stream filters", children: ["all", "stdout", "stderr"].map((filter) => (_jsx("button", { type: "button", className: `chip ${logFilter === filter ? "chip-active" : ""}`, onClick: () => setLogFilter(filter), children: filter }, filter))) }), _jsx("button", { type: "button", className: "btn btn-ghost", onClick: () => setLogsPaused((v) => !v), children: logsPaused ? "Resume" : "Pause" }), _jsx("button", { type: "button", className: "btn btn-ghost", onClick: () => setLogs([]), children: "Clear" }), _jsxs("div", { className: `stream-status stream-${streamState}`, "aria-live": "polite", children: [_jsx("span", { className: "stream-dot", "aria-hidden": "true" }), _jsxs("span", { children: ["Stream: ", streamState] })] })] })] }), _jsx("div", { className: "logs", role: "log", "aria-live": "polite", "aria-relevant": "additions text", "aria-atomic": "false", children: filteredLogs.length === 0 ? (_jsxs("div", { className: "empty-state", children: [_jsx("p", { children: "No log entries match this view." }), _jsx("span", { children: "Select a deployment and stream to inspect build and runtime output." })] })) : (filteredLogs.map((log, i) => (_jsxs("pre", { className: `log-line ${log.stream === "stderr" ? "stderr" : "stdout"}`, children: [_jsxs("span", { className: "mono", children: ["[", new Date(log.timestamp).toLocaleTimeString(), "]"] }), " ", log.stream, " | ", log.line] }, `${log.timestamp}-${i}`)))) })] })] }));
}
