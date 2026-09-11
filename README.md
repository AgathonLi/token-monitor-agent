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
| `v0.56.0` | Upstream Token Monitor version — pin this in compose |
| `latest` | Newest stable this overlay has built |
| `overlay-<sha>` | Git commit of this packaging repo |

## Quick start

```bash
git clone https://github.com/AgathonLi/token-monitor-agent.git
cd token-monitor-agent
cp .env.example .env
```

Then fill in:

| Field | What to put |
|---|---|
| `TOKEN_MONITOR_HUB_URL` | Hub origin, same as the widget — `https://token-monitor-hub.<your-subdomain>.workers.dev` |
| `TOKEN_MONITOR_SECRET` | Shared with the hub and the widget |
| `TOKEN_MONITOR_DEVICE_ID` | A name unique to this host, e.g. `nas-hermes` |
| Compose volume | Hermes data directory that holds `state.db`, mounted **rw** as uid `1000` |

```bash
docker compose -f compose/docker-compose.agent.yaml up -d
```

The image already collects Hermes (`TOKEN_MONITOR_CLIENTS=hermes`) with Limits off. Hermes reports token usage. Quota cards are the same Limits probes as the official agent — leave them off until you opt in below.

## Volumes

SQLite needs a writable mount so WAL and `-shm` files can be created. Give the agent its own volume for pid and archive files (`TOKEN_MONITOR_SHARED_DIR`) so those stay out of the Hermes data directory.

`compose/docker-compose.agent.yaml` is a starting point: point the bind at your Hermes data dir and pin the image version tag.

## Limits

This image runs the official headless agent, so Limits probing is in the binary. The overlay default is `TOKEN_MONITOR_LIMITS_ENABLED=0` because Hermes has no Limits provider — collecting `$HERMES_HOME/state.db` fills **token** totals only.

A 24/7 container is a good Limits clock for **static API keys** (OpenRouter, DeepSeek, Minimax Token Plan, Volcengine, GLM / Z.ai, Kimi Code, Copilot token, `GROK_BEARER_TOKEN`). Cookie, CLI, and desktop-login providers (Claude/Codex CLI, Cursor, Antigravity, Trae, Alibaba, Ollama, Qoder, Zed, Command Code, WorkBuddy on Linux) stay on the widget.

Hub Limits keep the freshest **valid** row per account (usage **adds**). Allowlist providers, put their keys in the host `.env`, and turn the same ones off on the widget.

```env
TOKEN_MONITOR_LIMITS_ENABLED=1
TOKEN_MONITOR_LIMIT_PROVIDERS=openrouter,deepseek,minimax,volcengine,zai,kimi
OPENROUTER_API_KEY=
DEEPSEEK_API_KEY=
```

Commented copy with more keys is in `.env.example`. The complete list lives in Token Monitor’s [`.env.example`](https://github.com/Javis603/token-monitor/blob/main/.env.example).

## Configuration

Copy `.env.example` next to the compose file. Precedence matches upstream: CLI flag → env → image default.

If the host cannot reach the Hub on the default route, set `HTTP_PROXY` / `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` (Node `fetch` ignores proxy env without that flag). The full variable list is in Token Monitor’s [configuration reference](https://github.com/Javis603/token-monitor/blob/main/docs/configuration.md).

## Acknowledgments

- [Token Monitor](https://github.com/Javis603/token-monitor) by [@Javis](https://github.com/Javis603) — widget, hub protocol, and the agent this image runs.
- [tokscale](https://github.com/junhoyeo/tokscale) — log parsing, via Token Monitor’s vendored pin.

## License

[MIT](LICENSE). Packaging © 2026 Agathon. Token Monitor © 2026 Javis. Keep both copyright notices when you redistribute.

Conventions for coding agents are in [AGENTS.md](AGENTS.md).
