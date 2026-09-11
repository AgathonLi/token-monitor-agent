<p align="right">
   <strong>EN</strong> | <a href="./README.zh-CN.md">简</a>
</p>

# Token Monitor Agent

<p align="center">
   <em>Unofficial Docker overlay for the Token Monitor headless agent.</em>
</p>

<p align="center">
   <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-A855F7?style=flat-square" alt="License: MIT" /></a>
   <a href="https://github.com/Javis603/token-monitor"><img src="https://img.shields.io/badge/upstream-Javis603%2Ftoken--monitor-22c55e?style=flat-square" alt="Upstream Token Monitor" /></a>
   <a href="https://github.com/AgathonLi/token-monitor-agent/pkgs/container/token-monitor-agent"><img src="https://img.shields.io/badge/image-ghcr.io-blue?style=flat-square" alt="GHCR" /></a>
</p>

Independent packaging repo that builds a **linux/amd64** image of the [Token Monitor](https://github.com/Javis603/token-monitor) headless agent from an official **stable Release**. It is **not** the official app, not an official image, and not [Token Monitor Web](https://github.com/AgathonLi/token-monitor-web).

The image is `ghcr.io/agathonli/token-monitor-agent`. Tags: upstream version (`v0.56.0`, …), `latest` (newest stable this overlay has built), overlay git SHA (`overlay-<sha>`).

## What this repo contains

Overlay only. Upstream source is **not** vendored and **not** a git submodule. The Dockerfile shallow-clones `Javis603/token-monitor` at the tag in `upstream.lock.json`.

| File | Role |
|---|---|
| `Dockerfile` | `node:22-bookworm-slim`, `npm ci --omit=dev`, vendored tokscale linux-x64, `USER 1000`, `CMD node src/agent/agent.js` |
| `upstream.lock.json` | Pinned official non-prerelease tag + commit |
| `compose/docker-compose.agent.yaml` | Example sidecar compose (placeholders only) |
| `.env.example` | Host env names — no secrets, no real Hub URL |

CI polls official non-prerelease Releases every 6 hours, updates the lock on this `main`, and buildx-pushes **linux/amd64** when the lock or Dockerfile changes.

## Run

Pin a version tag. Do not use `latest` on a host you care about.

```bash
cp .env.example .env
# fill TOKEN_MONITOR_HUB_URL, TOKEN_MONITOR_SECRET, TOKEN_MONITOR_DEVICE_ID
# point the compose bind at the Hermes data dir that owns state.db (rw, uid 1000)
docker compose -f compose/docker-compose.agent.yaml up -d
```

Image defaults: `TOKEN_MONITOR_CLIENTS=hermes`, `TOKEN_MONITOR_LIMITS_ENABLED=0`. Hermes has no Limits provider in Token Monitor; this collector is for usage totals.

SQLite must be mounted **read-write**. A `:ro` bind breaks WAL/`-shm`. `TOKEN_MONITOR_SHARED_DIR` must be its **own** rw volume so pid/archive files are not written next to `state.db`.

Hub URL has no `/api/...` suffix. Use a device id that does not collide with the desktop widget.

## Acknowledgments

- [Token Monitor](https://github.com/Javis603/token-monitor) by [@Javis](https://github.com/Javis603) — desktop widget, hub protocol, and the headless agent this image runs.
- Tokscale binaries come from that project's vendored pin, not from this overlay.

## License

[MIT](LICENSE). Overlay copyright © 2026 Agathon. Token Monitor (cloned into the image at build time) copyright © 2026 Javis. Keep both copyright notices and the permission text when you redistribute.

Conventions for coding agents are in [AGENTS.md](AGENTS.md).
