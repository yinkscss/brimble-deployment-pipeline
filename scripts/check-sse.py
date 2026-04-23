#!/usr/bin/env python3
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

BASE_URL = os.environ.get("BASE_URL", "http://localhost")


def http_json(method: str, url: str, body: bytes | None = None, headers: dict[str, str] | None = None) -> dict:
    req = urllib.request.Request(url, method=method, data=body, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def create_sample_zip_bytes(sample_dir: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sample_dir.rglob("*"):
            if path.is_file():
                zf.write(path, arcname=f"sample-app/{path.relative_to(sample_dir)}")
    return buf.getvalue()


def create_deployment_from_zip(repo_root: Path) -> dict:
    zip_bytes = create_sample_zip_bytes(repo_root / "sample-app")
    payload_path = repo_root / "tmp" / "check-sse-sample.zip"
    payload_path.parent.mkdir(parents=True, exist_ok=True)
    payload_path.write_bytes(zip_bytes)
    command = [
        "curl",
        "-sS",
        "-X",
        "POST",
        "-F",
        f"project_file=@{payload_path}",
        f"{BASE_URL}/api/deployments",
    ]
    result = subprocess.run(command, cwd=repo_root, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def wait_for_terminal_status(deployment_id: str, timeout_s: int = 240) -> str:
    started = time.time()
    while time.time() - started < timeout_s:
        deployment = http_json("GET", f"{BASE_URL}/api/deployments/{deployment_id}")
        status = deployment["status"]
        if status in ("running", "failed", "deleted"):
            return status
        time.sleep(3)
    raise RuntimeError(f"Timed out waiting for deployment {deployment_id} terminal status")


def fetch_sse_snapshot(deployment_id: str, cursor: str | None = None, timeout_s: int = 10) -> str:
    url = f"{BASE_URL}/api/deployments/{deployment_id}/logs"
    if cursor:
        url = f"{url}?cursor={cursor}"
    req = urllib.request.Request(url, method="GET")
    started = time.time()
    lines: list[str] = []
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        while time.time() - started < timeout_s:
            raw = resp.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace")
            lines.append(line)
            if line.startswith("event: pipeline_done") or line.startswith("event: pipeline_failed"):
                break
    return "".join(lines)


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    try:
        deployment = create_deployment_from_zip(repo_root)
        deployment_id = deployment["id"]
        status = wait_for_terminal_status(deployment_id)

        snapshot = fetch_sse_snapshot(deployment_id)
        if "id: " not in snapshot:
            raise RuntimeError("SSE snapshot missing event ids")
        if "event: pipeline_done" not in snapshot and "event: pipeline_failed" not in snapshot:
            raise RuntimeError("SSE snapshot missing terminal event")

        # Cursor replay check: request with last observed event id and ensure server still responds.
        cursor = None
        for line in snapshot.splitlines():
            if line.startswith("id: "):
                cursor = line.replace("id: ", "", 1).strip()
        if cursor:
            cursor_snapshot = fetch_sse_snapshot(deployment_id, cursor=cursor)
            if "event: pipeline_done" not in cursor_snapshot and "event: pipeline_failed" not in cursor_snapshot:
                raise RuntimeError("Cursor SSE snapshot missing terminal event")

        print(f"PASS: SSE stream/replay validated for deployment {deployment_id} ({status})")
        return 0
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
