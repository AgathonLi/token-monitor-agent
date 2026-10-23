#!/usr/bin/env python3
"""Docker image smoke gate for token-monitor-agent."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import uuid

DEFAULT_TIMEOUT_S = 180
DAEMON_ERROR_PATTERNS = (
    "cannot connect to the docker daemon",
    "is the docker daemon running",
    "docker daemon is not running",
)


def verify_image_metadata(image: str) -> tuple[int, str]:
    """Inspects and validates image metadata (User, Cmd, os/arch)."""
    try:
        proc = subprocess.run(
            ["docker", "image", "inspect", image],
            text=True,
            capture_output=True,
            timeout=30,
        )
    except FileNotFoundError as err:
        return 125, f"[SETUP BLOCKER] Docker CLI not found: {err}"
    except subprocess.TimeoutExpired as err:
        return 124, f"[ERROR] docker image inspect timed out: {err}"

    if proc.returncode != 0:
        stderr = proc.stderr or ""
        if any(p in stderr.lower() for p in DAEMON_ERROR_PATTERNS):
            return 125, f"[SETUP BLOCKER] Docker daemon is not accessible: {stderr.strip()}"
        return proc.returncode, f"[ERROR] docker image inspect failed:\n{stderr.strip()}"

    try:
        data = json.loads(proc.stdout)
        item = data[0] if isinstance(data, list) else data
        cfg = item.get("Config") or item.get("config") or {}
        user = cfg.get("User")
        cmd = cfg.get("Cmd")
        arch = item.get("Architecture") or item.get("architecture")
        os_name = item.get("Os") or item.get("os")

        if user != "1000:1000":
            return 1, f"[ERROR] Invalid Config.User: expected '1000:1000', got {user!r}"
        if cmd != ["node", "src/agent/agent.js"]:
            return 1, f"[ERROR] Invalid Config.Cmd: expected ['node', 'src/agent/agent.js'], got {cmd!r}"
        if arch != "amd64" or os_name != "linux":
            return 1, f"[ERROR] Invalid os/arch: expected linux/amd64, got {os_name}/{arch}"
    except Exception as err:
        return 1, f"[ERROR] Failed to parse image inspect data: {err}"

    return 0, ""


def build_docker_run_command(
    image: str,
    smoke_script_path: str | Path,
    container_name: str,
    tmpfs_size: str = "64m",
) -> list[str]:
    """Constructs the docker run command line."""
    abs_script = str(Path(smoke_script_path).resolve())
    return [
        "docker",
        "run",
        "--name",
        container_name,
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--security-opt=no-new-privileges",
        "--cap-drop=ALL",
        "--user",
        "1000:1000",
        "--tmpfs",
        f"/tmp:rw,size={tmpfs_size},mode=1777",
        "-v",
        f"{abs_script}:/tmp/overlay-smoke.js:ro",
        "--entrypoint",
        "node",
        "-w",
        "/app",
        image,
        "/tmp/overlay-smoke.js",
    ]


def run_smoke(
    image: str,
    smoke_script_path: str | Path | None = None,
    timeout_s: int = DEFAULT_TIMEOUT_S,
) -> int:
    """Runs the smoke test container and returns the exit code."""
    if smoke_script_path is None:
        smoke_script_path = Path(__file__).resolve().parent / "smoke_agent.js"
    if not Path(smoke_script_path).is_file():
        print(f"[ERROR] Smoke script is not a file: {smoke_script_path}", file=sys.stderr)
        return 2

    meta_code, meta_err = verify_image_metadata(image)
    if meta_code != 0:
        if meta_err:
            print(meta_err, file=sys.stderr)
        return meta_code

    container_name = f"tm-smoke-{uuid.uuid4().hex[:8]}"
    cmd = build_docker_run_command(image, smoke_script_path, container_name)

    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout_s)
    except FileNotFoundError as err:
        print(f"[SETUP BLOCKER] Docker CLI not found: {err}", file=sys.stderr)
        return 125
    except subprocess.TimeoutExpired as err:
        print(f"[ERROR] Smoke run timed out after {timeout_s}s: {err}", file=sys.stderr)
        return 124
    finally:
        try:
            subprocess.run(["docker", "rm", "-f", container_name], capture_output=True, timeout=10)
        except Exception:
            pass

    if proc.returncode != 0:
        stderr_lower = (proc.stderr or "").lower()
        if any(pattern in stderr_lower for pattern in DAEMON_ERROR_PATTERNS):
            print(f"[SETUP BLOCKER] Docker daemon is not accessible: {proc.stderr.strip()}", file=sys.stderr)
            return 125
        print(proc.stdout)
        print(proc.stderr, file=sys.stderr)
        return proc.returncode

    if proc.stdout:
        print(proc.stdout)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Smoke test token-monitor-agent image")
    parser.add_argument("image", help="Container image tag")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_S, help="Timeout in seconds")
    args = parser.parse_args(argv)
    return run_smoke(image=args.image, timeout_s=args.timeout)


if __name__ == "__main__":
    sys.exit(main())
