const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
export async function createDeployment(gitUrl) {
    const trimmed = gitUrl.trim();
    const res = await fetch(`${API_BASE}/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ git_url: trimmed })
    });
    if (!res.ok)
        throw new Error(await res.text());
    return res.json();
}
export async function createDeploymentFromUpload(file) {
    const formData = new FormData();
    formData.append("project_file", file);
    const res = await fetch(`${API_BASE}/deployments`, {
        method: "POST",
        body: formData
    });
    if (!res.ok)
        throw new Error(await res.text());
    return res.json();
}
export async function listDeployments() {
    const res = await fetch(`${API_BASE}/deployments`);
    if (!res.ok)
        throw new Error(await res.text());
    return res.json();
}
export async function getDeployment(id) {
    const res = await fetch(`${API_BASE}/deployments/${id}`);
    if (!res.ok)
        throw new Error(await res.text());
    return res.json();
}
export async function deleteDeployment(id) {
    const res = await fetch(`${API_BASE}/deployments/${id}`, { method: "DELETE" });
    if (!res.ok)
        throw new Error(await res.text());
}
export function logsSseUrl(id) {
    return `${API_BASE}/deployments/${id}/logs`;
}
