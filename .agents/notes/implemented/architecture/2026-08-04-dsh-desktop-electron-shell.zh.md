# Agent Note：dsh-desktop —— Web GUI 的 Electron 外壳

Status: implemented

[English](2026-08-04-dsh-desktop-electron-shell.md) | 中文

> 范围：新的产品组装 `apps/desktop`（`@deepseek-ai/dsh-desktop`），把现有 `dsh web` GUI 承载到独立 Electron 窗口并带托盘常驻，外加其自包含打包方案（electron-builder + `dsh-desktop-closure` deploy root，用 `pnpm deploy` 物化、在 Electron-as-Node 下运行）。

> 部分取代：[GUI 分层与 RPC 协议 note](2026-07-19-gui-layering-and-rpc-protocol.md) 曾为将来的 Electron 形态预设 IPC fetch 载体；本外壳以 HTTP 客户端形态落地，复用现有 `dsh web` webserver。该 note 的协议本体（四象限消息模型）仍然有效。

## Problem

Web GUI 是产品交互最丰富的界面，却活在浏览器标签页里：没有任务栏存在感、没有托盘、没有独立窗口外观，每次启动都要开终端、起 `dsh web`、保住标签页。用户要求独立窗口。GUI 本质是客户端-服务器架构——`dsh web` 在 `127.0.0.1:<port>` 提供本地 HTTP API 和静态外壳——因此「桌面应用」不可能是单进程，必须是拥有服务器生命周期的客户端外壳。外壳因此要解决：`dsh web` 从哪来（检出目录、PATH 还是内置）、如何免配置得知端口（服务器支持 `--port 0`，OS 分配）、如何探测就绪（`dsh web` 在 listen 之后才打印 `dsh web: http://127.0.0.1:<port>`）、以及窗口生命周期与服务器生命周期的关系（托盘常驻：关闭 ≠ 退出）。

## Decision

**`apps/desktop` 是薄的 Electron 主进程，负责 spawn `dsh web` 并管理其生命周期；所有决策逻辑与 Electron 无关且被单测覆盖。** `src/launcher.ts` 按固定顺序解析服务器命令——`DSH_BIN` 环境变量、嵌入闭包（`deploy/node_modules/@deepseek-ai/dsh/lib/bin.js`）、本检出目录的 CLI（构建产物 `lib/bin.js`，否则 tsx 源码启动）、PATH 上的 `dsh`——以 `web --host 127.0.0.1 --port 0` 启动，把 stdout 缓冲成行，解析就绪行（要求显式端口，因此被 chunk 切开的半行永远不会误匹配），并以短超时轮询 HTTP 200。`src/main.ts` 只是 Electron 胶水：单实例锁、窗口（沙箱渲染进程、无 preload）、托盘、子进程生命周期。在 Windows 上 `child.kill()` 是 `TerminateProcess`，退出时服务器收不到优雅 dispose 信号；会话 JSONL 按事件落盘，已记录内容不会丢失——这一点记录在文档里而不是绕开它。

**托盘常驻，而不是窗口生命周期。** 关闭窗口只隐藏它，服务器继续运行；托盘菜单重新打开窗口或退出（同时杀掉服务器）。二次启动聚焦已有窗口。打包版不需要 Node、`dsh` 或检出目录：嵌入闭包在 Electron-as-Node（`ELECTRON_RUN_AS_NODE=1`）下运行，且带 `--expose-internals`——harness 的 HMR 服务需要 Node 内部模块，而 `node-addon-require-builtin` 回退在 Electron 的 V8 下不可用（缺少 `GetAlignedPointerFromEmbedderData` 符号）。闭包内的原生插件（node-pty、koffi）是 N-API，无需针对 Electron 重新编译（`npmRebuild: false`）。

**打包用共享 lockfile deploy，而不是 `--legacy`。** `apps/desktop/closure` 是纯依赖 deploy root，其 110 项清单镜像 `python/sdk-runtime` 的 harness 闭包，外加 Web 专属 seam 包（`dsh-atomic-write`、`dsh-session-telemetry`、`dsh-session-telemetry-otel`、`dsh-session-title-first-message-llm`、`dsh-session-title-llm`、`dsh-spill`、`dsh-spill-local`、`dsh-spill-policy`）与 `@deepseek-ai/dsh` + `@deepseek-ai/dsh-frontend`；它同时列出 `@deepseek-ai/dsh-process-tree`——`main.ts` 与 reaper 共用的 tree-kill 原语——让解包的 deploy 树携带两者运行时都要 import 的代码（打包应用没有 node_modules，Electron-as-Node 也读不了 asar 内部，因此 deploy/ 是唯一运行时可达的位置；dev 需要先 `deploy:closure` 物化）。源码以 `../deploy/node_modules/@deepseek-ai/dsh-process-tree/lib/index.js` 引入，tsc 原样把它写进 lib/types/——比 src/ 深一层——因此 `scripts/patch-deploy-imports.mjs`（在包 `build` 中接在 tsc 之后）把产物里的 specifier 改写为 `../../deploy/...`，即从产物位置能到达 deploy 树的前缀；`apps/web` 增加了 `files: ["dist"]` 字段，让构建好的 GUI 进入闭包。物化命令为 `pnpm deploy --prod` 加 `--config.inject-workspace-packages=true --config.node-linker=hoisted --config.strict-dep-builds=false`——共享 lockfile 路径会复制每个包（结果零符号链接）。**pnpm 11.7.0 的 `pnpm deploy --legacy` 会非确定性地丢掉一部分 workspace 包**（仓库自己的 `python/sdk-runtime` 管线在该 pnpm 下同样中招）；不要重新引入。electron-builder 只打包 `lib/`、`build/`（图标）与 `deploy/`，并配 `asarUnpack: deploy/** + lib/types/reaper.js`（Electron-as-Node 子进程读不了 `app.asar` 内部）；本包自身零运行时依赖，因此 electron-builder 对 node_modules 的处理永远不会碰到闭包。`dist` 先跑完整仓库构建（`build:lib` + `build:web`），因为闭包复制的是构建产物而非源码。

## Alternatives considered

- **PWA「安装为应用」**——零新依赖、今天就能用，但窗口仍是浏览器、没有托盘、安装入口随浏览器而异；用户明确选择了真正的桌面外壳。
- **Tauri**——比 Electron 轻，但需要用户没有的 Rust 工具链；Electron 是纯 Node/pnpm，与仓库现状一致。
- **固定 3080 端口再解析 URL**——否决：`--port 0` + 就绪行免配置且永远不会与现有 `dsh web` 冲突（浏览器版与桌面版可并存）。
- **用 `@yao-pkg/pkg --sea` 打包整个 harness**（Python SDK 路线）——SEA 管线目前只支持 linux/macos，嵌入 web dist 资产还需要新的 pkg 资产管线；Electron-as-Node + `pnpm deploy` 闭包以零新增构建设施达成同样的自包含。
- **Windows 上 `child.kill()` 是强杀**——stdin 命令通道或 `GenerateConsoleCtrlEvent` 能让服务器走优雅 dispose；v1 因 JSONL 事件级持久化而不需要，推迟。

## Consequences

`pnpm --filter @deepseek-ai/dsh-desktop dev` 从检出目录以独立窗口打开 GUI；`dist` 产出 NSIS 安装包和免安装 exe，无需任何预装工具即可运行。启动器逻辑有无密钥单测（`apps/desktop/tests/launcher.spec.ts`）；Electron 胶水刻意薄到无需快照。服务器 stdout 以 `[dsh web]` 前缀转发；打包版不在别处写日志。v1 已知瑕疵：打包版内 harness 源码提示段会命名 unpacked deploy 树中一个存在但并非 harness 检出目录的路径（纯装饰，启动时无人读取）、调用目录即 workspace 的语义让开始菜单启动落在 shell 的 cwd、托盘图标主题是单一反色 PNG、外部链接一律经系统浏览器离开应用（前两项在 README 中亦有记录）。
