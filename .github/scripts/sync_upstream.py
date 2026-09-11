#!/usr/bin/env python3
"""Pin Javis603/token-monitor to the latest official non-prerelease Release."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = ROOT / "upstream.lock.json"
SOURCE = "Javis603/token-monitor"
API = "https://api.github.com"


def gh(path: str) -> dict:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    req = urllib.request.Request(
        f"{API}{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "token-monitor-agent-overlay",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def peel_tag(tag: str) -> str:
    ref = gh(f"/repos/{SOURCE}/git/refs/tags/{tag}")
    obj = ref["object"]
    if obj["type"] == "commit":
        return obj["sha"]
    tagged = gh(f"/repos/{SOURCE}/git/tags/{obj['sha']}")
    return tagged["object"]["sha"]


def write_output(**kwargs: str) -> None:
    out = os.environ.get("GITHUB_OUTPUT")
    if not out:
        for key, value in kwargs.items():
            print(f"{key}={value}")
        return
    with open(out, "a", encoding="utf-8") as handle:
        for key, value in kwargs.items():
            handle.write(f"{key}={value}\n")


def main() -> int:
    latest = gh(f"/repos/{SOURCE}/releases/latest")
    if latest.get("draft") or latest.get("prerelease"):
        print("latest release is draft or prerelease; leaving lock unchanged", file=sys.stderr)
        write_output(changed="false")
        return 0

    tag = str(latest["tag_name"])
    commit = peel_tag(tag)
    lock = {
        "schemaVersion": 1,
        "source": SOURCE,
        "tag": tag,
        "version": tag[1:] if tag.startswith("v") else tag,
        "commit": commit,
        "publishedAt": latest.get("published_at"),
        "tarballUrl": latest.get("tarball_url"),
        "htmlUrl": latest.get("html_url"),
        "prerelease": False,
    }
    previous = json.loads(LOCK_PATH.read_text(encoding="utf-8")) if LOCK_PATH.exists() else {}
    if previous.get("tag") == lock["tag"] and previous.get("commit") == lock["commit"]:
        print(f"{SOURCE} {tag} already pinned")
        write_output(changed="false", tag=tag, commit=commit)
        return 0

    LOCK_PATH.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
    subprocess.run(["git", "add", str(LOCK_PATH)], cwd=ROOT, check=True)
    diff = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT)
    if diff.returncode == 0:
        write_output(changed="false", tag=tag, commit=commit)
        return 0
    subprocess.run(
        ["git", "commit", "-m", f"chore: pin {SOURCE} {tag}"],
        cwd=ROOT,
        check=True,
    )
    subprocess.run(["git", "push", "origin", "HEAD:main"], cwd=ROOT, check=True)
    print(f"updated lock to {tag} ({commit})")
    write_output(changed="true", tag=tag, commit=commit)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
