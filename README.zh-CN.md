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
| `v0.89.0` | 上游版本示例 — compose 中固定经过验证的 Release |
| `latest` | 本包装层已构建的最新稳定版 |
| `overlay-<sha>` | 本仓库的 git 提交 |

当前构建版本以 `upstream.lock.json` 为准。compose 的部署版本独立固定：CI 不会升级运行中的容器，也不会改写宿主配置。

## 快速开始

这是一份**首次部署**的操作示例，适用于还没有运行 agent 的机器。已有部署请沿用你自己的文件，不要重新用模板覆盖现有配置。

前提：一台 **linux/amd64** 主机，已安装 Docker 与 `docker compose` 插件，并且 Hub 已经可用、可连通（与小部件同一个）。镜像是预构建的——运行它不需要在宿主上安装 Node/npm。

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

接着编辑 `compose/docker-compose.agent.yaml`：把 `/path/to/hermes-data` 换成真实的完整 Hermes 主目录，并核对固定的镜像 tag、两处 `rw` 挂载（Hermes 数据挂载与独立的 shared 卷）、`1000:1000` 用户，以及专用卷 `token-monitor-agent-shared`。

启动前先校验——校验与启动使用完全相同的 `--env-file`/`-f` 参数，保证两侧读取同一份配置；`config --quiet` 只是省略渲染输出，并不是“绝不会输出密钥”的绝对承诺。用 `&&` 连接，校验失败就不继续启动：

```bash
docker compose --env-file compose/.env -f compose/docker-compose.agent.yaml config --quiet && \
docker compose --env-file compose/.env -f compose/docker-compose.agent.yaml up -d
```

镜像默认采集 Hermes（`TOKEN_MONITOR_CLIENTS=hermes`），Limits 关闭（`TOKEN_MONITOR_LIMITS_ENABLED=0`），会话标题同步默认关闭（`TOKEN_MONITOR_SYNC_SESSION_TITLES=0`）；同时关闭文件事件触发，默认每五分钟提交一次用量汇总（`TOKEN_MONITOR_INTERVAL_MS=300000`）。注意五分钟是用量上报周期，而非全部 HTTP 请求的严格上限（启动能力握手或重试请求不受此限）。

额度卡片用的是和上游 agent 同一套 Limits 探针——默认关掉，要开再按下节配置。

## 数据卷与 Hermes 日归属

SQLite 需要可写挂载，才能创建 WAL 和 `-shm`。将完整的 Hermes 主目录挂到容器内的 `/opt/data`，包括 `state.db`、profiles 及 `logs/agent.log*`，使用 **rw** 挂载和 uid `1000`。

新版 Tokscale / Token Monitor 解析器支持基于每个数据库旁边的 `logs/agent.log*`（包括 `$HERMES_HOME/profiles/*/` 下的 profile 数据库与其日志），按实际 API 调用日期拆分多日会话用量。SQLite 数据库依然是权威总量：仅有日志覆盖的部分按调用日期拆分，未被日志覆盖的剩余用量仍归属到 `started_at`，日志量超报时整体回退到数据库记录。这显著改善了跨午夜归属，但不能承诺完全修复所有历史会话。

pid 与归档请放到单独的独立 rw 卷（`TOKEN_MONITOR_SHARED_DIR`，如 `/var/lib/token-monitor-agent`），与 Hermes 数据目录分开。升级或更改时区时保留此卷，以便采集器继续使用已保存的历史。

## 额度（Limits）

这个镜像跑的就是官方无头采集器，Limits 探针都在。包装层默认 `TOKEN_MONITOR_LIMITS_ENABLED=0`：Hermes 没有 Limits 提供方，采集 `$HERMES_HOME/state.db` 只填 **Token 用量**。

24/7 容器适合用 **静态 API key** 去刷额度（OpenRouter、DeepSeek、Minimax Token Plan、Volcengine、GLM / Z.ai、Kimi Code、Ollama Cloud API key、Copilot token、`GROK_BEARER_TOKEN`）。Ollama Cloud 使用 `TOKEN_MONITOR_OLLAMA_API_KEY`（或 `OLLAMA_API_KEY`）；选择启用时，在提供方 allowlist 中加入 `ollama`。Cookie、CLI、桌面登录类（Claude/Codex CLI、Cursor、Antigravity、Trae、Alibaba、Ollama Cookie 模式、Qoder、Zed、Command Code，以及 Linux 上的 WorkBuddy）留在小部件。

Hub 对额度按账号保留最新一条有效记录（用量是加总）。请 allowlist 提供方、把 key 放进 `compose/.env`，并在小部件里关掉同样的项。compose 默认使用了 `${TOKEN_MONITOR_LIMITS_ENABLED:-0}`，在 `compose/.env` 中配置 `TOKEN_MONITOR_LIMITS_ENABLED=1` 可直接生效，不会被 compose 硬编码覆盖。

```env
TOKEN_MONITOR_LIMITS_ENABLED=1
TOKEN_MONITOR_LIMIT_PROVIDERS=openrouter,deepseek,minimax,volcengine,zai,kimi
OPENROUTER_API_KEY=
DEEPSEEK_API_KEY=
```

更多 key 的注释示例在 `.env.example`。完整列表见 Token Monitor 的 [`.env.example`](https://github.com/Javis603/token-monitor/blob/main/.env.example)。

## 配置

把 `.env.example` 复制为 `compose/.env`（位于 compose 文件旁边，仅首次部署）。所有 compose 命令保持显式的 `--env-file compose/.env` 参数。两条优先级链各自独立：

- **agent 本身**：CLI 参数 → 容器环境变量 → 镜像默认值。`compose/.env` 的值以容器环境变量的形式进入 agent。
- **Compose 的取值来源**：compose 文件中的 `${...}` 占位符从 shell 环境变量、项目 `.env` 或 `--env-file` 解析；service 的 `env_file` 列表不参与 Compose 插值，service 内部 `environment` 优先于 `env_file`。

下文的配置链接指向上游 `main`，可能超前于你镜像所打包的稳定版；版本不一致时，以实际部署镜像版本对应的文档为准。

- **时区**：在 `compose/.env` 中配置 `TZ`（如 `TZ=Asia/Shanghai`，默认 `UTC`），需与 Hermes 写日志的时区一致。日志解析器按该时区解释日志时间戳，采集器也会将系统时区显式传给 Tokscale，用于用量周期和每日图表。请在启动前配置；修改 `TZ` 后需重新创建容器，仅修改看板时区无法纠正设备端的分桶。采集器观察到新时区后会全量重扫，并按时区分别保留每日历史；已保存的历史保留原记录，不会自动修复。
- **采集节奏**：镜像默认按周期采集：`TOKEN_MONITOR_WATCH=0`、`TOKEN_MONITOR_INTERVAL_MS=300000`（五分钟用量上传周期）。若确实需要秒级更新，可以自行改为 `TOKEN_MONITOR_WATCH=1`；`TOKEN_MONITOR_WATCH_POLLING=1` 只是在轮询方式下监听文件，并不会限制 Hub 上传频率，活跃的 SQLite 数据库可能每次文件变化都产生一次请求。
- **会话标题**：`TOKEN_MONITOR_SYNC_SESSION_TITLES=0`（默认）不上传会话标题；用量、费用、模型及按日/月的统计继续正常同步——所以这不是完全匿名开关，也不影响 Hermes 本地展示的标题，更不是上传聊天正文的开关。标题可能暴露项目/客户信息，没有特别需求请保持 `0`。`1` 是发送端选择开启，还要求 Hub 支持并允许接收标题，展示端也要支持。若曾开启后再关闭：关闭会请求清理服务器侧的标题，该请求失败时需重试并保留 shared 状态；此前已导出的副本或备份无法撤销。确认后的 OFF 协商结果由 **agent 协商器**缓存（不是 Hub），后续上传直接复用、不再逐轮询问；未支持能力接口的旧版 Hub 仍可完成基本用量同步，但 agent 可能每轮重复能力 GET 探测。
- **出站代理**：若主机默认路由到不了 Hub，设置 `HTTP_PROXY` / `HTTPS_PROXY`，并加上 `NODE_USE_ENV_PROXY=1`（没有这面旗，Node 的 `fetch` 不走代理）。这组变量作用于 agent 容器内遵循它们的 HTTP 客户端——Hub 请求包括在内，也可能涉及其他 API 流量——并不配置 Docker 守护进程的网络，拉镜像仍走 daemon 自己的路由层；不要为了一层顺便去改 Hermes、DNS、Hub 或 TLS。完整变量列表见 Token Monitor 的[设置参考](https://github.com/Javis603/token-monitor/blob/main/docs/configuration.md)。
- **变更后重建**：修改 env 值后需要重建服务（再次 `up -d`）；单纯 `restart` 既不会读取新的 env 值，也不会换用新镜像。

## 版本固定、升级与回退

- 标签不是精确制品。`vX.Y.Z` 标签可能因同版本包装修订而被重建；`overlay-<sha>` 虽用完整的包装 commit SHA 标识一次源码修订，但终究只是 tag。部署时用选定制品真实的 registry manifest digest 固定：`image: ghcr.io/agathonli/token-monitor-agent@sha256:...`——示例中的 `sha256:...` 只是格式占位，不是可以永久沿用的 digest。
- 两种指纹不要混淆：OCI config digest（即 Docker image ID，本地 `docker image inspect` 打印的那种）与 `image@sha256` 固定所用的 registry manifest digest 是不同的东西；千万不要把本地 image ID 当作部署的 manifest digest，而 `image@sha256` 引用也只有携带选定制品真实的 manifest digest 时才是精确固定。
- 升级按下面的可移植清单操作（本仓库示例是 `compose/docker-compose.agent.yaml` 里的 `token-monitor-agent`；已有自定义部署沿用**真实**的项目名、配置路径与插值 env）：
  1. 记录运行中的项目名、service、设备 ID 与卷（`docker inspect`），并在本地保留实际旧镜像的引用。
  2. 先拉取选定的新镜像（如 `docker pull ghcr.io/agathonli/token-monitor-agent:vX.Y.Z`）再停旧 agent，可缩短停机。拉取走 Docker 守护进程自身的路由，与 agent 的 `HTTP_PROXY` 无关。
  3. 只停 agent 容器——不需要停 Hermes；此时才能备份 `TOKEN_MONITOR_SHARED_DIR`，不要复制在用的 SQLite 文件。改动任何文件之前，先把原 compose 文件与含密钥的 env 文件备份到 Hermes 主目录、shared 卷之外且不会被同步的目录，env 备份保持 `0600`。
  4. 只更新镜像（及必要设置），继续使用原 shared 卷，并用原项目名、配置路径与插值参数重建原 service。沿用同一 `TOKEN_MONITOR_DEVICE_ID` 可避免产生重复设备：

     ```bash
     docker compose --env-file compose/.env -f compose/docker-compose.agent.yaml up -d --no-deps --force-recreate token-monitor-agent
     ```

     命令对应本仓库示例的文件与 service；自定义部署沿用真实的项目名、文件路径和自己的插值参数。
  5. 失败时：先停掉新 agent，需要时再用 shared 备份恢复原卷；恢复原配置与实际的旧镜像（会移动的远程 tag 不是回退方式）。按原参数重新运行 `config --quiet` 校验，按第 4 步同样的方式重建原 service，并重复一遍部署后检查——仅通过校验不等于回退完成。
- 切不可作为升级步骤执行：`down -v`、清空所有卷或删除数据目录——这些会丢掉采集器历史，无法撤销。

## 部署后检查

`up -d` 之后在宿主上核对（日志与 inspect 输出可能包含你的私有 Hub 地址——只在本地查看、反馈前先脱敏；不要把容器完整 `Config.Env` 或渲染后的 compose 配置原样贴出，其中可能携带密钥）：

- 容器身份：沿用启动时的 `--env-file`/`-f` 参数，自定义部署还须保留原项目名与路径。下面的命令链在没有运行中的容器 ID 或任一步失败时停止，只打印实际镜像 ID/引用、配置用户、挂载目标/`RW`，以及容器内进程的 uid/gid 与时区，不输出完整环境：

```bash
CID=$(docker compose --env-file compose/.env -f compose/docker-compose.agent.yaml ps -q token-monitor-agent) &&
test -n "$CID" &&
docker inspect --type container --format 'ImageId={{.Image}} ImageRef={{.Config.Image}} User={{.Config.User}} {{range .Mounts}}{{.Destination}}={{.RW}} {{end}}' "$CID" &&
docker exec "$CID" node -e 'console.log(process.getuid(), process.getgid(), process.env.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone)'
```

  确认 uid/gid 为 `1000/1000`、时区符合预期，且两处挂载（`/opt/data` 与 shared 目录）均为 `rw`。将 `ImageId` 与已拉取的目标镜像的本地 image ID 比对；仅看 `ImageRef` 可能仍是会移动的标签。本地有某个镜像，不等于实际运行的就是它。
- agent 日志：同一设备 ID 向 Hub 上报且用量上传成功——以“上传成功”的日志行为准，不只是容器没退出。
- 除了这条，还要打开 Hub（小部件或 Token Monitor Web / 看板）读回来：该设备的更新时间刷新、用量汇总出现、设备没有重复条目。上传成功的日志行与容器在运行，都不能代替接收端显示数据。
- 首次启动可能对较大的 `state.db` 做全量重扫，耗时取决于库的大小，不承诺固定时长。

出现故障时分层排查：

- `fetch failed` / 连不上 Hub → 检查 agent 的 `HTTP_PROXY` / `HTTPS_PROXY` / `NODE_USE_ENV_PROXY` 设置与出站连通性；镜像拉取是 daemon 层的独立路径。
- `401` / 上传被拒 → `TOKEN_MONITOR_SECRET` 与 Hub 不一致，或 `TOKEN_MONITOR_HUB_URL` 填错。
- SQLite 报错 / `/opt/data` 权限拒绝 → 挂载必须是 `rw`，且文件对 uid `1000` 可读写。
- 超大数据库扫描超时 → 已有 `TOKEN_MONITOR_TOKSCALE_TIMEOUT_MS` 选项（`.env.example` 中的 `180000` 是示例值，不是镜像通用默认）。

## 验证与维护

- **只跟稳定版**：本包装层仅跟随 `upstream.lock.json` 中记录的 `Javis603/token-monitor` 官方稳定 Release，不追踪未发布的 `main` 分支或 prerelease。`npm ci` 保留上游锁定的依赖，重建同一版本不会自动获得新的依赖安全修复；应跟进包含修复的下一稳定版，或单独审核例外补丁。
- **本地构建与冒烟测试**：
  1. 本地构建镜像：`docker buildx build --platform linux/amd64 --load -t token-monitor-agent:local .`
  2. 运行 `python3 .github/scripts/smoke_image.py token-monitor-agent:local`。脚本使用合成 SQLite 数据、禁用网络，检查真实 agent、Token 分桶、profile 发现及日归属；另用固定时钟与注入的扫描结果，验证镜像内采集器的持久化、重启复用及多时区历史保留。CI 在发布前执行同一验收。通过该门禁只证明镜像在合成数据上的行为正确——不等于在你自己的机器上通过验收。
- **Registry 发布验证**：
  CI 自动检测 GHCR 注册表已发布的三个标签（`vX.Y.Z`、`latest`、`overlay-<sha>`），确认三标签对应同一镜像。若检测失败或标签不一致，则触发重试。
- **发布路径**：触及构建输入（`Dockerfile`、`upstream.lock.json`、`compose/**`、tests、`.env.example`）的 push 会触发 overlay 工作流自动构建并发布；仅改动 README 的 push 不会触发构建。

## 致谢

- [Token Monitor](https://github.com/Javis603/token-monitor)（[@Javis](https://github.com/Javis603)）— 桌面小部件、Hub 协议，以及本镜像所运行的采集器。
- [tokscale](https://github.com/junhoyeo/tokscale) — 日志解析，使用 Token Monitor 自己的 vendor pin。

## 许可证

[MIT](LICENSE)。包装层 © 2026 Agathon。Token Monitor © 2026 Javis。再分发时请保留两行版权。

给编码助手的约定见 [AGENTS.md](AGENTS.md)。
