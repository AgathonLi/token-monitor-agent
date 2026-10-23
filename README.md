<p align="right">
   <strong>EN</strong> | <a href="./README.zh-CN.md">简</a>
</p>

# Token Monitor Agent

<p align="center">
   <em>Headless Token Monitor, packaged for Linux hosts.</em>
</p>

<p align="center">
   <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-A855F7?style=flat-square" alt="License: MIT" /></a>
   <a href="https://github.com/Javis603/token-monitor"><img src="https://img.shields.io/badge/companion_to-Token%20Monitor-22c55e?style=flat-square" alt="Companion to Token Monitor" /></a>
   <a href="https://github.com/AgathonLi/token-monitor-agent/pkgs/container/token-monitor-agent"><img src="https://img.shields.io/badge/image-ghcr.io-blue?style=flat-square" alt="GHCR" /></a>
</p>

## What is this?

[Token Monitor](https://github.com/Javis603/token-monitor) is a desktop widget that reads local AI-tool logs and, in sync mode, posts summaries to your hub. This repo turns that same headless agent into a **linux/amd64** image, built from each official stable Release.

Use it when the logs live on a Linux machine the widget cannot see — for example Hermes on a NAS, where usage sits in `$HERMES_HOME/state.db`. The container reads those files and posts to the same hub as your other devices.

Community packaging of Javis’s agent. The [desktop app](https://github.com/Javis603/token-monitor) and the [web board](https://github.com/AgathonLi/token-monitor-web) are separate projects.

## How it works

```text
Hermes (state.db)  ──▶  this agent  ──▶  your hub  ──▶  widget / Token Monitor Web
```

The Dockerfile shallow-clones `Javis603/token-monitor` at the tag in `upstream.lock.json`, runs `npm ci --omit=dev`, and installs the vendored tokscale linux-x64 binary. Every six hours CI looks for a new stable Release, updates the lock, and publishes:

`ghcr.io/agathonli/token-monitor-agent`

| Tag | Meaning |
|---|---|
| `v0.77.0` | Example upstream version — pin a verified release in compose |
| `latest` | Newest stable release built by this overlay |
| `overlay-<sha>` | Git commit of this packaging repo |

Check `upstream.lock.json` for the current build pin. A compose deployment pin is independent: CI does not upgrade running containers or rewrite your host configuration.

## Quick start

```bash
git clone https://github.com/AgathonLi/token-monitor-agent.git
cd token-monitor-agent
cp .env.example compose/.env
chmod 600 compose/.env
```

Then fill in `compose/.env`:

| Field | What to put |
|---|---|
| `TOKEN_MONITOR_HUB_URL` | Hub origin, same as the widget — `https://token-monitor-hub.<your-subdomain>.workers.dev` |
| `TOKEN_MONITOR_SECRET` | Shared with the hub and the widget |
| `TOKEN_MONITOR_DEVICE_ID` | A name unique to this host, e.g. `nas-hermes` |
| `TZ` | Timezone where Hermes writes logs, e.g. `Asia/Shanghai` (defaults to `UTC`) |
| Compose volume | Hermes home directory holding `state.db`, profiles, and `logs/agent.log*`, mounted **rw** as uid `1000` |

```bash
docker compose --env-file compose/.env -f compose/docker-compose.agent.yaml up -d
```

The image collects Hermes (`TOKEN_MONITOR_CLIENTS=hermes`) with Limits off (`TOKEN_MONITOR_LIMITS_ENABLED=0`) and session title sync disabled (`TOKEN_MONITOR_SYNC_SESSION_TITLES=0`) by default. It disables file-triggered collection and posts usage summaries every five minutes (`TOKEN_MONITOR_INTERVAL_MS=300000`). This five-minute interval is the usage upload cadence, not a strict ceiling on all HTTP requests (such as initial capability checks or retry traffic).

Quota cards use the same Limits probes as the upstream agent — leave them off until you opt in below.

## Volumes and Hermes Daily Attribution

SQLite needs a writable mount so WAL and `-shm` files can be created. Mount the complete Hermes home directory at the container's `/opt/data`, including `state.db`, profiles, and `logs/agent.log*`, **rw** as uid `1000`.

Newer Tokscale / Token Monitor parsers split multi-day session usage across dates using API-call entries in `logs/agent.log*` located alongside each database (`$HERMES_HOME/state.db` as well as profile databases in `$HERMES_HOME/profiles/*/state.db`). The database remains the authoritative total: only the log-covered portion is split across call dates. Any unlogged remainder falls back to `started_at`, and an over-reporting log causes fallback to the database total. This improves attribution across midnight boundaries, but does not promise complete retrospective repair.

Keep `TOKEN_MONITOR_SHARED_DIR` on its own independent rw volume (e.g. `/var/lib/token-monitor-agent`) so agent pid, lock, and archive files do not sit in the Hermes data directory.

## Limits

This image runs the official headless agent, so Limits probing is in the binary. The overlay default is `TOKEN_MONITOR_LIMITS_ENABLED=0` because Hermes has no Limits provider — collecting `$HERMES_HOME/state.db` fills **token** totals only.

A 24/7 container is a good Limits clock for **static API keys** (OpenRouter, DeepSeek, Minimax Token Plan, Volcengine, GLM / Z.ai, Kimi Code, Copilot token, `GROK_BEARER_TOKEN`). Cookie, CLI, and desktop-login providers (Claude/Codex CLI, Cursor, Antigravity, Trae, Alibaba, Ollama, Qoder, Zed, Command Code, WorkBuddy on Linux) stay on the widget.

Hub Limits keep the freshest **valid** row per account (usage **adds**). Allowlist providers, put their keys in `compose/.env`, and turn the same ones off on the widget. Compose defaults to `${TOKEN_MONITOR_LIMITS_ENABLED:-0}`, so setting `TOKEN_MONITOR_LIMITS_ENABLED=1` in `compose/.env` takes effect without being overridden.

```env
TOKEN_MONITOR_LIMITS_ENABLED=1
TOKEN_MONITOR_LIMIT_PROVIDERS=openrouter,deepseek,minimax,volcengine,zai,kimi
OPENROUTER_API_KEY=
DEEPSEEK_API_KEY=
```

Commented copy with more keys is in `.env.example`. The complete list lives in Token Monitor’s [`.env.example`](https://github.com/Javis603/token-monitor/blob/main/.env.example).

## Configuration

Copy `.env.example` to `compose/.env` next to the compose file. Precedence matches upstream: CLI flag → env → image default.

- **Timezone**: Set `TZ` in `compose/.env` (e.g. `TZ=Asia/Shanghai`, default `UTC`) to match the timezone where Hermes writes logs. The log parser converts wall-clock log timestamps using the container's local timezone before daily bucketing; changing the report timezone on the dashboard cannot correct misattributed hours.
- **Collection cadence**: The image defaults to periodic collection with `TOKEN_MONITOR_WATCH=0` and `TOKEN_MONITOR_INTERVAL_MS=300000` (five-minute usage upload cadence). For seconds-level freshness you can opt in with `TOKEN_MONITOR_WATCH=1`; `TOKEN_MONITOR_WATCH_POLLING=1` only selects a polling watcher and does not cap Hub uploads, so an active SQLite database can generate one request per filesystem event.
- **Session titles**: `TOKEN_MONITOR_SYNC_SESSION_TITLES=0` keeps title sync off by default. A newer Hub caches OFF for the process lifetime; an older Hub without capability endpoints still completes usage sync but may repeat capability GET checks.
- **Outbound proxy**: If the host cannot reach the Hub on the default route, set `HTTP_PROXY` / `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` (Node `fetch` ignores proxy env without that flag). The full variable list is in Token Monitor’s [configuration reference](https://github.com/Javis603/token-monitor/blob/main/docs/configuration.md).

## Verification and Maintenance

- **Stable-only releases**: This overlay packages official stable Releases from `Javis603/token-monitor` tracked in `upstream.lock.json`. It does not follow unreleased `main` or prereleases. `npm ci` preserves upstream's locked dependencies; rebuilding the same release does not pick up newer dependency security fixes. Follow the next fixed stable release, or review an exception separately.
- **Local build and smoke test**:
  1. Build the image locally: `docker buildx build --platform linux/amd64 --load -t token-monitor-agent:local .`
  2. Run `python3 .github/scripts/smoke_image.py token-monitor-agent:local`. It uses synthetic SQLite data with no network access to check the real agent, token buckets, profile discovery, and daily attribution. CI runs this gate before publishing.
- **Registry verification**:
  Automated checks confirm that the registry (GHCR) publishes all three tags (`vX.Y.Z`, `latest`, `overlay-<sha>`) and verify that all three tags resolve to the same image artifact. If tags are missing or inconsistent, publication is retried.

## Acknowledgments

- [Token Monitor](https://github.com/Javis603/token-monitor) by [@Javis](https://github.com/Javis603) — widget, hub protocol, and the agent this image runs.
- [tokscale](https://github.com/junhoyeo/tokscale) — log parsing, via Token Monitor’s vendored pin.

## License

[MIT](LICENSE). Packaging © 2026 Agathon. Token Monitor © 2026 Javis. Keep both copyright notices when you redistribute.

Conventions for coding agents are in [AGENTS.md](AGENTS.md).
