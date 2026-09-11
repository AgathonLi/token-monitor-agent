<p align="right">
   <a href="./README.md">EN</a> | <strong>简</strong>
</p>

# Token Monitor Agent

<p align="center">
   <em>非官方的 Token Monitor headless agent Docker 包装层。</em>
</p>

<p align="center">
   <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-A855F7?style=flat-square" alt="License: MIT" /></a>
   <a href="https://github.com/Javis603/token-monitor"><img src="https://img.shields.io/badge/upstream-Javis603%2Ftoken--monitor-22c55e?style=flat-square" alt="上游 Token Monitor" /></a>
   <a href="https://github.com/AgathonLi/token-monitor-agent/pkgs/container/token-monitor-agent"><img src="https://img.shields.io/badge/image-ghcr.io-blue?style=flat-square" alt="GHCR" /></a>
</p>

独立包装仓：按官方**稳定 Release**浅克隆 [Token Monitor](https://github.com/Javis603/token-monitor) 的 headless agent，构建 **linux/amd64** 镜像。这**不是**官方应用，不是官方镜像，也不是 [Token Monitor Web](https://github.com/AgathonLi/token-monitor-web)。

镜像：`ghcr.io/agathonli/token-monitor-agent`。标签：官方版本（`v0.56.0` 等）、`latest`（本包装层已构建的最新稳定版）、包装层 git SHA（`overlay-<sha>`）。

## 仓库里有什么

只有 overlay。不 vendor 上游源码，不用 submodule。Dockerfile 按 `upstream.lock.json` 里的 tag 浅克隆 `Javis603/token-monitor`。

| 文件 | 作用 |
|---|---|
| `Dockerfile` | `node:22-bookworm-slim`，`npm ci --omit=dev`，vendored tokscale linux-x64，`USER 1000`，`CMD node src/agent/agent.js` |
| `upstream.lock.json` | 钉住官方非 prerelease 的 tag + commit |
| `compose/docker-compose.agent.yaml` | 示例 sidecar compose（占位路径） |
| `.env.example` | 主机环境变量名 — 无密钥、无真实 Hub 地址 |

CI 每 6 小时同步官方非 prerelease，更新本仓 `main` 的 lock；lock 或 Dockerfile 变更则 buildx 推送 **linux/amd64**。

## 运行

生产请钉版本 tag，不要用 `latest`。

```bash
cp .env.example .env
# 填写 TOKEN_MONITOR_HUB_URL、TOKEN_MONITOR_SECRET、TOKEN_MONITOR_DEVICE_ID
# 把 compose 的 bind 指到拥有 state.db 的 Hermes 数据目录（rw，uid 1000）
docker compose -f compose/docker-compose.agent.yaml up -d
```

镜像默认：`TOKEN_MONITOR_CLIENTS=hermes`，`TOKEN_MONITOR_LIMITS_ENABLED=0`。Token Monitor 没有 Hermes 的 Limits 提供者；这台采集器只报用量。

SQLite 必须 **rw** 挂载。`:ro` 会让 WAL/`-shm` 失败。`TOKEN_MONITOR_SHARED_DIR` 必须是**单独**的 rw 卷，pid/归档不要写到 `state.db` 旁边。

Hub URL 不要加 `/api/...`。设备 id 不要和桌面小部件冲突。

## 致谢

- [Token Monitor](https://github.com/Javis603/token-monitor)（[@Javis](https://github.com/Javis603)）— 桌面小部件、Hub 协议，以及本镜像所运行的 headless agent。
- Tokscale 二进制来自该项目自己的 vendor pin，不是本包装层提供的。

## 许可

[MIT](LICENSE)。包装层版权 © 2026 Agathon。构建时克隆进镜像的 Token Monitor 版权 © 2026 Javis。再分发时请保留两行版权和许可全文。

给编码助手的约定见 [AGENTS.md](AGENTS.md)。
