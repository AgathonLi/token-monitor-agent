<p align="right">
   <a href="./README.md">EN</a> | <strong>简</strong>
</p>

# Token Monitor Agent

<p align="center">
   <em>给 Linux 主机用的 Token Monitor 无头采集镜像。</em>
</p>

<p align="center">
   <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-A855F7?style=flat-square" alt="许可证：MIT" /></a>
   <a href="https://github.com/Javis603/token-monitor"><img src="https://img.shields.io/badge/companion_to-Token%20Monitor-22c55e?style=flat-square" alt="配合 Token Monitor 使用" /></a>
   <a href="https://github.com/AgathonLi/token-monitor-agent/pkgs/container/token-monitor-agent"><img src="https://img.shields.io/badge/image-ghcr.io-blue?style=flat-square" alt="GHCR" /></a>
</p>

## 这是什么？

[Token Monitor](https://github.com/Javis603/token-monitor) 是一款桌面小部件：读取本机 AI 工具日志，同步模式下把汇总发到你的 Hub。本仓库把同一套 headless agent 打成 **linux/amd64** 镜像，跟随官方稳定 Release 构建。

适合日志在 Linux 上、小部件够不着的场景——比如 NAS 上的 Hermes，用量在 `$HERMES_HOME/state.db`。容器读这些文件，发到和其他设备相同的 Hub。

这是对 Javis 采集器的社区包装。[桌面应用](https://github.com/Javis603/token-monitor) 和 [网页看板](https://github.com/AgathonLi/token-monitor-web) 是另外的项目。

## 工作原理

```text
Hermes（state.db）  ──▶  本采集器  ──▶  你的 Hub  ──▶  小部件 / Token Monitor Web
```

Dockerfile 按 `upstream.lock.json` 里的 tag 浅克隆 `Javis603/token-monitor`，执行 `npm ci --omit=dev`，并装上 vendored 的 tokscale linux-x64。CI 每六小时查看一次新的稳定 Release，更新 lock，然后发布：

`ghcr.io/agathonli/token-monitor-agent`

| 标签 | 含义 |
|---|---|
| `v0.56.0` | 上游 Token Monitor 版本 — compose 里钉这个 |
| `latest` | 本包装层已构建的最新稳定版 |
| `overlay-<sha>` | 本仓库的 git 提交 |

## 快速开始

```bash
git clone https://github.com/AgathonLi/token-monitor-agent.git
cd token-monitor-agent
cp .env.example .env
```

然后填写：

| 项 | 填什么 |
|---|---|
| `TOKEN_MONITOR_HUB_URL` | 和小部件相同的 Hub 源站，例如 `https://token-monitor-hub.<你的子域>.workers.dev` |
| `TOKEN_MONITOR_SECRET` | 与 Hub、小部件共用的密钥 |
| `TOKEN_MONITOR_DEVICE_ID` | 这台主机自己的名字，例如 `nas-hermes` |
| compose 数据卷 | 存放 `state.db` 的 Hermes 数据目录，**rw** 挂载，uid `1000` |

```bash
docker compose -f compose/docker-compose.agent.yaml up -d
```

镜像默认采集 Hermes（`TOKEN_MONITOR_CLIENTS=hermes`），Limits 关闭；同时关闭文件事件触发，默认每五分钟提交一次，避免 SQLite 每次文件变化都产生 Hub 请求。Hermes 只上报 Token 用量。额度卡片用的是和官方 agent 同一套 Limits 探针——默认关掉，要开再按下节配置。

## 数据卷

SQLite 需要可写挂载，才能创建 WAL 和 `-shm`。pid 与归档请放到单独的卷（`TOKEN_MONITOR_SHARED_DIR`），和 Hermes 数据目录分开。

`compose/docker-compose.agent.yaml` 是起点：把 bind 指到 Hermes 数据目录，并钉住镜像的版本标签。

## 额度（Limits）

镜像跑的就是官方无头采集器，Limits 探针都在。包装层默认 `TOKEN_MONITOR_LIMITS_ENABLED=0`：Hermes 没有 Limits 提供方，采集 `$HERMES_HOME/state.db` 只填 **Token 用量**。

24/7 容器适合用 **静态 API key** 去刷额度（OpenRouter、DeepSeek、Minimax Token Plan、Volcengine、GLM / Z.ai、Kimi Code、Copilot token、`GROK_BEARER_TOKEN`）。Cookie、CLI、桌面登录类（Claude/Codex CLI、Cursor、Antigravity、Trae、Alibaba、Ollama、Qoder、Zed、Command Code，以及 Linux 上的 WorkBuddy）留在小部件。

Hub 对额度按账号保留最新一条有效记录（用量是加总）。请 allowlist 提供方、把 key 放进宿主机 `.env`，并在小部件里关掉同样的项。

```env
TOKEN_MONITOR_LIMITS_ENABLED=1
TOKEN_MONITOR_LIMIT_PROVIDERS=openrouter,deepseek,minimax,volcengine,zai,kimi
OPENROUTER_API_KEY=
DEEPSEEK_API_KEY=
```

更多 key 的注释示例在 `.env.example`。完整列表见 Token Monitor 的 [`.env.example`](https://github.com/Javis603/token-monitor/blob/main/.env.example)。

## 配置

把 `.env.example` 复制到 compose 旁边。优先级与上游一致：命令行参数 → 环境变量 → 镜像默认。

镜像默认按周期采集：`TOKEN_MONITOR_WATCH=0`、`TOKEN_MONITOR_INTERVAL_MS=300000`。若确实需要秒级更新，可以自行改为 `TOKEN_MONITOR_WATCH=1`；`TOKEN_MONITOR_WATCH_POLLING=1` 只是在轮询方式下监听文件，并不会限制 Hub 上传频率，活跃的 SQLite 数据库可能每次文件变化都产生一次请求。

若主机默认路由到不了 Hub，设置 `HTTP_PROXY` / `HTTPS_PROXY`，并加上 `NODE_USE_ENV_PROXY=1`（没有这面旗，Node 的 `fetch` 不走代理）。完整变量列表见 Token Monitor 的[设置参考](https://github.com/Javis603/token-monitor/blob/main/docs/configuration.md)。

## 致谢

- [Token Monitor](https://github.com/Javis603/token-monitor)（[@Javis](https://github.com/Javis603)）— 桌面小部件、Hub 协议，以及本镜像所运行的采集器。
- [tokscale](https://github.com/junhoyeo/tokscale) — 日志解析，使用 Token Monitor 自己的 vendor pin。

## 许可证

[MIT](LICENSE)。包装层 © 2026 Agathon。Token Monitor © 2026 Javis。再分发时请保留两行版权。

给编码助手的约定见 [AGENTS.md](AGENTS.md)。
