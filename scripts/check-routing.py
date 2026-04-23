#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path


BASE_URL = os.environ.get("BASE_URL", "http://localhost")

def http_json(method: str, url: str, body: bytes | None = None, headers: dict[str, str] | None = None) -> dict:
    req = urllib.request.Request(url, method=method, data=body, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_text(url: str) -> str:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def list_deployments() -> list[dict]:
    payload = http_json("GET", f"{BASE_URL}/api/deployments")
    if not isinstance(payload, list):
        raise RuntimeError(f"Unexpected deployments response: {payload}")
    return payload


def route_deployment_ids(routes: list[dict]) -> set[str]:
    ids: set[str] = set()
    for route in routes:
        route_id = route.get("@id")
        if isinstance(route_id, str) and route_id.startswith("app-"):
            ids.add(route_id.removeprefix("app-"))
    return ids


def choose_running_deployment_with_route(deployments: list[dict], routed_ids: set[str]) -> dict | None:
    for deployment in deployments:
        deployment_id = deployment.get("id")
        if (
            deployment.get("status") == "running"
            and deployment.get("caddy_route")
            and deployment.get("container_id")
            and isinstance(deployment_id, str)
            and deployment_id in routed_ids
        ):
            return deployment
    return None


def get_caddy_routes_via_compose(repo_root: Path) -> list[dict]:
    command = [
        "docker",
        "compose",
        "exec",
        "-T",
        "caddy",
        "sh",
        "-lc",
        "curl -sS http://localhost:2019/config/apps/http/servers/srv0/routes",
    ]
    result = subprocess.run(command, cwd=repo_root, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def assert_route_precedence(routes: list[dict], deployment_id: str) -> None:
    route_id = f"app-{deployment_id}"
    deployment_index = next((i for i, route in enumerate(routes) if route.get("@id") == route_id), None)
    if deployment_index is None:
        raise RuntimeError(f"Could not find Caddy route with id {route_id}")

    catch_all_index = next((i for i, route in enumerate(routes) if not route.get("match")), None)
    if catch_all_index is None:
        raise RuntimeError("Could not find Caddy catch-all route to verify ordering")

    if deployment_index >= catch_all_index:
        raise RuntimeError(
            f"Route order invalid: deployment route index {deployment_index} is not before catch-all {catch_all_index}"
        )


def assert_apps_response(deployment_id: str) -> None:
    body = http_text(f"{BASE_URL}/apps/{deployment_id}/")
    if "Brimble Take Home" in body or "/@vite/client" in body:
        snippet = body[:160].replace("\n", " ")
        raise RuntimeError(f"/apps/{deployment_id} appears to be frontend fallback, not app response: {snippet}")

    if not body.strip():
        raise RuntimeError(f"/apps/{deployment_id} returned empty response body")


def check_stack_health() -> None:
    health = http_json("GET", f"{BASE_URL}/api/health")
    if not health.get("ok"):
        raise RuntimeError("API health check failed")


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    try:
        check_stack_health()

        routes = get_caddy_routes_via_compose(repo_root)
        routed_ids = route_deployment_ids(routes)
        existing = choose_running_deployment_with_route(list_deployments(), routed_ids)
        if not existing:
            raise RuntimeError(
                "No running deployment currently routed by Caddy. Create one deployment from the UI/API, then rerun this check."
            )

        deployment_id = existing["id"]
        print(f"Using existing running deployment: {deployment_id}")
        assert_route_precedence(routes, deployment_id)
        assert_apps_response(deployment_id)

        print(f"PASS: route order + /apps response verified for deployment {deployment_id}")
        return 0
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
