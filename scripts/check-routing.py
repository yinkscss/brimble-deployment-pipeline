#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path


BASE_URL = os.environ.get("BASE_URL", "http://localhost")
TIMEOUT_SECONDS = int(os.environ.get("CHECK_TIMEOUT_SECONDS", "240"))
POLL_SECONDS = 2


def http_json(method: str, url: str, body: bytes | None = None, headers: dict[str, str] | None = None) -> dict:
    req = urllib.request.Request(url, method=method, data=body, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_text(url: str) -> str:
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def create_sample_zip(repo_root: Path) -> Path:
    sample_dir = repo_root / "sample-app"
    if not sample_dir.exists():
        raise RuntimeError("Missing sample-app directory")

    tmp_dir = Path(tempfile.mkdtemp(prefix="routing-check-"))
    zip_path = tmp_dir / "sample-app.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sample_dir.rglob("*"):
            if file_path.is_file():
                arcname = file_path.relative_to(repo_root)
                zf.write(file_path, arcname.as_posix())
    return zip_path


def build_multipart_form(file_path: Path, field_name: str = "project_file") -> tuple[bytes, str]:
    boundary = f"----routing-check-{uuid.uuid4().hex}"
    file_bytes = file_path.read_bytes()
    filename = file_path.name
    lines = []
    lines.append(f"--{boundary}\r\n".encode())
    lines.append(
        f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'.encode()
    )
    lines.append(b"Content-Type: application/zip\r\n\r\n")
    lines.append(file_bytes)
    lines.append(b"\r\n")
    lines.append(f"--{boundary}--\r\n".encode())
    body = b"".join(lines)
    content_type = f"multipart/form-data; boundary={boundary}"
    return body, content_type


def post_deployment_from_zip(zip_path: Path) -> str:
    body, content_type = build_multipart_form(zip_path)
    payload = http_json(
        "POST",
        f"{BASE_URL}/api/deployments",
        body=body,
        headers={"Content-Type": content_type},
    )
    deployment_id = payload.get("id")
    if not deployment_id:
        raise RuntimeError(f"Missing deployment id in response: {payload}")
    return deployment_id


def wait_for_terminal_status(deployment_id: str) -> dict:
    started = time.time()
    while time.time() - started < TIMEOUT_SECONDS:
        deployment = http_json("GET", f"{BASE_URL}/api/deployments/{deployment_id}")
        status = deployment.get("status")
        if status == "running":
            return deployment
        if status == "failed":
            raise RuntimeError(f"Deployment failed: {deployment_id}")
        time.sleep(POLL_SECONDS)
    raise RuntimeError(f"Timed out waiting for deployment to reach running state: {deployment_id}")


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
    if "hello from sample app" not in body:
        snippet = body[:160].replace("\n", " ")
        raise RuntimeError(f"Unexpected /apps response for deployment {deployment_id}: {snippet}")


def best_effort_delete(deployment_id: str) -> None:
    req = urllib.request.Request(f"{BASE_URL}/api/deployments/{deployment_id}", method="DELETE")
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except urllib.error.HTTPError:
        pass
    except Exception:
        pass


def check_stack_health() -> None:
    health = http_json("GET", f"{BASE_URL}/api/health")
    if not health.get("ok"):
        raise RuntimeError("API health check failed")


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    deployment_id: str | None = None
    zip_path: Path | None = None

    try:
        check_stack_health()
        zip_path = create_sample_zip(repo_root)
        deployment_id = post_deployment_from_zip(zip_path)
        wait_for_terminal_status(deployment_id)

        routes = get_caddy_routes_via_compose(repo_root)
        assert_route_precedence(routes, deployment_id)
        assert_apps_response(deployment_id)

        print(f"PASS: route order + /apps response verified for deployment {deployment_id}")
        return 0
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    finally:
        if deployment_id:
            best_effort_delete(deployment_id)
        if zip_path and zip_path.exists():
            try:
                zip_path.unlink()
                zip_path.parent.rmdir()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
