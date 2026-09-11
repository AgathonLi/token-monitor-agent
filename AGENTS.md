# Token Monitor Agent — Agent 工作指针

本文件供会自动加载 `AGENTS.md` 的助手使用。它不是项目事实源。

## 接手时必读（按顺序）

1. `README.md`（英文）与 `README.zh-CN.md`（简体）
2. `LICENSE`
3. `upstream.lock.json`
4. 重新核对目录内实际文件，不要只信交接文本

人类 README 不要写本机绝对路径、不要写「红线」清单。那些只放在本文件。

## 刚性红线

- 独立包装仓，**不是**官方 Token Monitor，也不是 Token Monitor Web。禁止对外写成官方镜像 / 官方 agent。
- 不要修改 `AgathonLi/token-monitor` fork 的 `main`（那是 Hub fork，Sync fork 必须能快进）
- 不要 vendor / submodule 上游源码；构建时浅克隆 `upstream.lock.json` 钉住的官方**非 prerelease** Release
- 不要把 Hub URL、`TOKEN_MONITOR_SECRET`、真实 `workers.dev` 子域写进镜像、README、compose、lock 或 CI
- 不要在本仓写飞牛 / NAS 的真实 compose、`agent.env`、Watchtower
- 镜像默认 `TOKEN_MONITOR_CLIENTS=hermes`、`TOKEN_MONITOR_LIMITS_ENABLED=0`；额度另议
- SQLite 卷必须 rw、uid 1000；`TOKEN_MONITOR_SHARED_DIR` 单独 rw 卷，不要写进 Hermes `state.db` 旁
- 遵守 MIT：保留 `LICENSE` 里 **Agathon** 与 **Javis (Token Monitor)** 两行版权
- 远程默认 **public**。未确认不要 force-push、改 remote

## 冲突处理

本文件只做自动注入指针。与 `README.md` / `LICENSE` / `upstream.lock.json` 冲突时，以后者为准，并先停下询问用户。不要把本文件扩写成第二套规范。
