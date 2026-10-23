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
| `v0.77.0` | 上游版本示例 — compose 中固定经过验证的 Release |
| `latest` | 本包装层已构建的最新稳定版 |
| `overlay-<sha>` | 本仓库的 git 提交 |

当前构建版本以 `upstream.lock.json` 为准。compose 的部署版本独立固定：CI 不会升级运行中的容器，也不会改写宿主配置。

## 快速开始

```bash
git clone https://github.com/AgathonLi/token-monitor-agent.git
cd token-monitor-agent
cp .env.example compose/.env
chmod 600 compose/.env
```

然后填写 `compose/.env`：

| 项 | 填什么 |
|---|---|
| `TOKEN_MONITOR_HUB_URL` | 和小部件相同的 Hub 源站，例如 `https://token-monitor-hub.<你的子域>.workers.dev` |
| `TOKEN_MONITOR_SECRET` | 与 Hub、小部件共用的密钥 |
| `TOKEN_MONITOR_DEVICE_ID` | 这台主机自己的名字，例如 `nas-hermes` |
| `TZ` | Hermes 写日志的时区，例如 `Asia/Shanghai`（默认 `UTC`） |
| compose 数据卷 | 存放 `state.db`、profiles 与 `logs/agent.log*` 的 Hermes 主目录，**rw** 挂载，uid `1000` |

```bash
docker compose --env-file compose/.env -f compose/docker-compose.agent.yaml up -d
```

镜像默认采集 Hermes（`TOKEN_MONITOR_CLIENTS=hermes`），Limits 关闭（`TOKEN_MONITOR_LIMITS_ENABLED=0`），会话标题同步默认关闭（`TOKEN_MONITOR_SYNC_SESSION_TITLES=0`）；同时关闭文件事件触发，默认每五分钟提交一次用量汇总（`TOKEN_MONITOR_INTERVAL_MS=300000`）。注意五分钟是用量上报周期，而非全部 HTTP 请求的严格上限（启动能力握手或重试请求不受此限）。

额度卡片用的是和上游 agent 同一套 Limits 探针——默认关掉，要开再按下节配置。

## 数据卷与 Hermes 日归属

SQLite 需要可写挂载，才能创建 WAL 和 `-shm`。将完整的 Hermes 主目录挂到容器内的 `/opt/data`，包括 `state.db`、profiles 及 `logs/agent.log*`，使用 **rw** 挂载和 uid `1000`。

新版 Tokscale / Token Monitor 解析器支持基于每个数据库旁边的 `logs/agent.log*`（包括 `$HERMES_HOME/profiles/*/` 下的 profile 数据库与其日志），按实际 API 调用日期拆分多日会话用量。SQLite 数据库依然是权威总量：仅有日志覆盖的部分按调用日期拆分，未被日志覆盖的剩余用量仍归属到 `started_at`，日志量超报时整体回退到数据库记录。这显著改善了跨午夜归属，但不能承诺完全修复所有历史会话。

pid 与归档请放到单独的独立 rw 卷（`TOKEN_MONITOR_SHARED_DIR`，如 `/var/lib/token-monitor-agent`），与 Hermes 数据目录分开。

## 额度（Limits）

这个镜像跑的就是官方无头采集器，Limits 探针都在。包装层默认 `TOKEN_MONITOR_LIMITS_ENABLED=0`：Hermes 没有 Limits 提供方，采集 `$HERMES_HOME/state.db` 只填 **Token 用量**。

24/7 容器适合用 **静态 API key** 去刷额度（OpenRouter、DeepSeek、Minimax Token Plan、Volcengine、GLM / Z.ai、Kimi Code、Copilot token、`GROK_BEARER_TOKEN`）。Cookie、CLI、桌面登录类（Claude/Codex CLI、Cursor、Antigravity、Trae、Alibaba、Ollama、Qoder、Zed、Command Code，以及 Linux 上的 WorkBuddy）留在小部件。

Hub 对额度按账号保留最新一条有效记录（用量是加总）。请 allowlist 提供方、把 key 放进 `compose/.env`，并在小部件里关掉同样的项。compose 默认使用了 `${TOKEN_MONITOR_LIMITS_ENABLED:-0}`，在 `compose/.env` 中配置 `TOKEN_MONITOR_LIMITS_ENABLED=1` 可直接生效，不会被 compose 硬编码覆盖。

```env
TOKEN_MONITOR_LIMITS_ENABLED=1
TOKEN_MONITOR_LIMIT_PROVIDERS=openrouter,deepseek,minimax,volcengine,zai,kimi
OPENROUTER_API_KEY=
DEEPSEEK_API_KEY=
```

更多 key 的注释示例在 `.env.example`。完整列表见 Token Monitor 的 [`.env.example`](https://github.com/Javis603/token-monitor/blob/main/.env.example)。

## 配置

把 `.env.example` 复制为 `compose/.env`（位于 compose 文件旁边）。优先级与上游一致：命令行参数 → 环境变量 → 镜像默认。

- **时区**：在 `compose/.env` 中配置 `TZ`（如 `TZ=Asia/Shanghai`，默认 `UTC`），需与 Hermes 写日志的时区一致。日志解析器在归入报告日期前使用容器本地时区解析日志时间戳；在看板端修改报告时区无法纠正因本地时区偏差导致的解析错误。
- **采集节奏**：镜像默认按周期采集：`TOKEN_MONITOR_WATCH=0`、`TOKEN_MONITOR_INTERVAL_MS=300000`（五分钟用量上传周期）。若确实需要秒级更新，可以自行改为 `TOKEN_MONITOR_WATCH=1`；`TOKEN_MONITOR_WATCH_POLLING=1` 只是在轮询方式下监听文件，并不会限制 Hub 上传频率，活跃的 SQLite 数据库可能每次文件变化都产生一次请求。
- **会话标题**：`TOKEN_MONITOR_SYNC_SESSION_TITLES=0` 默认关闭会话标题同步。新版 Hub 成功协商后会在进程生命周期内缓存 OFF 状态；未支持能力接口的旧版 Hub 仍可完成基本用量同步，但可能在后续上传时重复进行能力 GET 探测。
- **出站代理**：若主机默认路由到不了 Hub，设置 `HTTP_PROXY` / `HTTPS_PROXY`，并加上 `NODE_USE_ENV_PROXY=1`（没有这面旗，Node 的 `fetch` 不走代理）。完整变量列表见 Token Monitor 的[设置参考](https://github.com/Javis603/token-monitor/blob/main/docs/configuration.md)。

## 验证与维护

- **只跟稳定版**：本包装层仅跟随 `upstream.lock.json` 中记录的 `Javis603/token-monitor` 官方稳定 Release，不追踪未发布的 `main` 分支或 prerelease。`npm ci` 保留上游锁定的依赖，重建同一版本不会自动获得新的依赖安全修复；应跟进包含修复的下一稳定版，或单独审核例外补丁。
- **本地构建与冒烟测试**：
  1. 本地构建镜像：`docker buildx build --platform linux/amd64 --load -t token-monitor-agent:local .`
  2. 运行 `python3 .github/scripts/smoke_image.py token-monitor-agent:local`。脚本使用合成 SQLite 数据、禁用网络，检查真实 agent、Token 分桶、profile 发现及日归属；CI 在发布前执行同一验收。
- **Registry 发布验证**：
  CI 自动检测 GHCR 注册表已发布的三个标签（`vX.Y.Z`、`latest`、`overlay-<sha>`），确认三标签对应同一镜像。若检测失败或标签不一致，则触发重试。

## 致谢

- [Token Monitor](https://github.com/Javis603/token-monitor)（[@Javis](https://github.com/Javis603)）— 桌面小部件、Hub 协议，以及本镜像所运行的采集器。
- [tokscale](https://github.com/junhoyeo/tokscale) — 日志解析，使用 Token Monitor 自己的 vendor pin。

## 许可证

[MIT](LICENSE)。包装层 © 2026 Agathon。Token Monitor © 2026 Javis。再分发时请保留两行版权。

给编码助手的约定见 [AGENTS.md](AGENTS.md)。
