#!/usr/bin/env python3
"""Check GHCR tags consistency and decide build/push requirements."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from typing import Sequence


def inspect_manifest(image_ref: str, timeout: int = 30) -> dict:
    """Run docker manifest inspect on image_ref and return parsed JSON."""
    result = subprocess.run(
        ["docker", "manifest", "inspect", image_ref],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"docker manifest inspect failed for {image_ref} (code {result.returncode}): {result.stderr.strip()}"
        )
    return json.loads(result.stdout)


def extract_digest(manifest_data: dict) -> str:
    # Single-platform config digest binds runtime settings and rootfs diff_ids.
    if not isinstance(manifest_data, dict) or manifest_data.get("schemaVersion") != 2:
        raise ValueError("Expected a schemaVersion 2 single-platform manifest")
    config = manifest_data.get("config")
    digest = config.get("digest") if isinstance(config, dict) else None
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("Missing or invalid config digest")
    return digest


def get_tag_digests(repo: str, tags: Sequence[str]) -> dict[str, str]:
    digests: dict[str, str] = {}
    for tag in tags:
        ref = f"{repo}:{tag}"
        manifest = inspect_manifest(ref)
        digest = extract_digest(manifest)
        digests[tag] = digest
    return digests


def check_tags_match(repo: str, tags: Sequence[str]) -> tuple[bool, str]:
    if not tags:
        return False, "no tags specified"
    try:
        digests = get_tag_digests(repo, tags)
    except (OSError, subprocess.SubprocessError, ValueError, RuntimeError) as exc:
        return False, f"inspection failed: {exc}"

    first_tag = tags[0]
    expected_digest = digests[first_tag]
    mismatches = [f"{t} ({digests[t]})" for t in tags[1:] if digests[t] != expected_digest]
    if mismatches:
        return False, f"digest mismatch: {first_tag} is {expected_digest}, but {', '.join(mismatches)}"
    return True, expected_digest


def should_build(
    event_name: str,
    sync_changed: bool,
    repo: str,
    tags: Sequence[str],
) -> tuple[bool, str]:
    if event_name in ("push", "workflow_dispatch"):
        return True, f"forced by event '{event_name}'"
    if sync_changed:
        return True, "upstream lock was updated"
    matched, detail = check_tags_match(repo, tags)
    if matched:
        return False, f"all tags exist and match digest ({detail})"
    return True, f"rebuild needed: {detail}"



def verify_published_tags(repo: str, tags: Sequence[str], expected_digest: str) -> None:
    """Verify all published tags exist and match. Raises on mismatch/failure."""
    matched, detail = check_tags_match(repo, tags)
    if not matched:
        raise RuntimeError(f"Post-publish verification failed: {detail}")
    if detail != expected_digest:
        raise RuntimeError(f"Published tags do not match the tested image: {detail} != {expected_digest}")
    print(f"Verified {len(tags)} tags in {repo} match digest: {detail}")


def write_output(**kwargs: str) -> None:
    out = os.environ.get("GITHUB_OUTPUT")
    if not out:
        for key, value in kwargs.items():
            print(f"{key}={value}")
        return
    with open(out, "a", encoding="utf-8") as handle:
        for key, value in kwargs.items():
            handle.write(f"{key}={value}\n")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="GHCR tag consistency and build checker")
    subparsers = parser.add_subparsers(dest="command", required=True)

    decide_parser = subparsers.add_parser("decide", help="Decide if image build & push should run")
    decide_parser.add_argument("--repo", required=True, help="Image repository")
    decide_parser.add_argument("--tags", nargs="+", required=True, help="Required tags to check")
    decide_parser.add_argument("--event", choices=["schedule", "push", "workflow_dispatch"], required=True)
    decide_parser.add_argument("--changed", default="false", help="Sync changed output")

    verify_parser = subparsers.add_parser("verify", help="Verify all tags exist and match")
    verify_parser.add_argument("--repo", required=True, help="Image repository")
    verify_parser.add_argument("--tags", nargs="+", required=True, help="Tags to verify")
    verify_parser.add_argument("--expected-digest", required=True, help="Config digest of the tested local image")

    args = parser.parse_args(argv)

    if args.command == "decide":
        sync_changed = (args.changed.strip().lower() == "true")
        build, reason = should_build(args.event, sync_changed, args.repo, args.tags)
        print(f"Decide: build={build} ({reason})")
        write_output(build="true" if build else "false")
        return 0

    if args.command == "verify":
        try:
            verify_published_tags(args.repo, args.tags, args.expected_digest)
            return 0
        except Exception as exc:
            print(f"Verification error: {exc}", file=sys.stderr)
            return 1

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
