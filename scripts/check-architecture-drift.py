#!/usr/bin/env python3
import json
import subprocess
import sys
from pathlib import Path


REQUIRED_SERVICES = {"db", "api", "frontend", "buildkit", "caddy"}
REQUIRED_CADDY_ENV = {"CADDY_ADMIN_URL", "APPS_BASE_PATH"}
REQUIRED_API_DEPENDS = {"db", "buildkit"}


def load_compose_config(repo_root: Path) -> dict:
    command = ["docker", "compose", "config", "--format", "json"]
    result = subprocess.run(command, cwd=repo_root, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def normalize_environment(raw: object) -> dict[str, str]:
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items()}

    env: dict[str, str] = {}
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str) and "=" in item:
                key, value = item.split("=", 1)
                env[key] = value
    return env


def check_services(compose: dict) -> None:
    services = compose.get("services")
    if not isinstance(services, dict):
        raise RuntimeError("Compose config missing top-level services map")

    missing = REQUIRED_SERVICES - set(services.keys())
    if missing:
        raise RuntimeError(f"Compose missing required services: {sorted(missing)}")


def check_caddy_single_ingress(compose: dict) -> None:
    services = compose["services"]
    caddy = services["caddy"]

    ports = caddy.get("ports", [])
    has_expected_public_port = False
    for port in ports:
        if port == "80:80":
            has_expected_public_port = True
        elif isinstance(port, dict):
            target = str(port.get("target", ""))
            published = str(port.get("published", ""))
            protocol = str(port.get("protocol", "tcp"))
            if target == "80" and published == "80" and protocol == "tcp":
                has_expected_public_port = True

    if not has_expected_public_port:
        raise RuntimeError("Caddy must publish host port 80 as single ingress (`80:80`)")

    for service_name, service in services.items():
        if service_name == "caddy":
            continue
        if service.get("ports"):
            raise RuntimeError(f"Service `{service_name}` must not publish host ports; ingress goes through Caddy")


def check_api_contract(compose: dict) -> None:
    api = compose["services"]["api"]
    env = normalize_environment(api.get("environment"))
    missing_env = REQUIRED_CADDY_ENV - set(env.keys())
    if missing_env:
        raise RuntimeError(f"API missing required ingress env vars: {sorted(missing_env)}")

    depends_on = api.get("depends_on", {})
    if not isinstance(depends_on, dict):
        raise RuntimeError("API depends_on must be declared for db/buildkit readiness")

    missing_depends = REQUIRED_API_DEPENDS - set(depends_on.keys())
    if missing_depends:
        raise RuntimeError(f"API missing required dependencies: {sorted(missing_depends)}")


def check_caddyfile(repo_root: Path) -> None:
    caddyfile = repo_root / "Caddyfile"
    text = caddyfile.read_text(encoding="utf-8")

    required_fragments = [
        "admin 0.0.0.0:2019",
        "handle_path /api/*",
        "reverse_proxy api:3001",
        "handle {",
        "reverse_proxy frontend:5173",
    ]
    for fragment in required_fragments:
        if fragment not in text:
            raise RuntimeError(f"Caddyfile missing required fragment: {fragment}")

    api_index = text.find("handle_path /api/*")
    catch_all_index = text.find("\n  handle {")
    if api_index == -1 or catch_all_index == -1 or api_index > catch_all_index:
        raise RuntimeError("Caddyfile route order invalid: `/api/*` handle must be before catch-all frontend handle")


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    try:
        compose = load_compose_config(repo_root)
        check_services(compose)
        check_caddy_single_ingress(compose)
        check_api_contract(compose)
        check_caddyfile(repo_root)
        print("PASS: architecture drift checks (compose + caddy ingress contracts)")
        return 0
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
