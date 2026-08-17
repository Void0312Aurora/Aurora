# Agent Note：dsh-desktop —— Web GUI 的 Electron 外壳

Status: implemented

[English](2026-08-04-dsh-desktop-electron-shell.md) | 中文

> 范围：新的产品组装 `apps/desktop`（`@deepseek-ai/dsh-desktop`），把现有 `dsh web` GUI 承载到独立 Electron 窗口并带托盘常驻，外加其自包含打包方案（electron-builder + `dsh-desktop-closure` deploy root，用 `pnpm deploy` 物化、在 Electron-as-Node 下运行）。

> 部分取代：[GUI 分层与 RPC 协议 note](2026-07-19-gui-layering-and-rpc-protocol.md) 曾为将来的 Electron 形态预设 IPC fetch 载体；本外壳以 HTTP 客户端形态落地，复用现有 `dsh web` webserver。该 note 的协议本体（四象限消息模型）仍然有效。

## Problem

Web GUI 是产品交互最丰富的界面，却活在浏览器标签页里：没有任务栏存在感、没有托盘、没有独立窗口外观，每次启动都要开终端、起 `dsh web`、保住标签页。用户要求独立窗口。GUI 本质是客户端-服务器架构——`dsh web` 在 `127.0.0.1:<port>` 提供本地 HTTP API 和静态外壳——因此「桌面应用」不可能是单进程，必须是拥有服务器生命周期的客户端外壳。外壳因此要解决：`dsh web` 从哪来（检出目录、PATH 还是内置）、如何免配置得知端口（服务器支持 `--port 0`，OS 分配）、如何探测就绪（`dsh web` 在 listen 之后才打印 `dsh web: http://127.0.0.1:<port>`）、以及窗口生命周期与服务器生命周期的关系（托盘常驻：关闭 ≠ 退出）。

## Decision

**`apps/desktop` 是薄的 Electron 主进程，负责 spawn `dsh web` 并管理其生命周期；启动器决策与 Electron 无关，而组装后的生命周期通过构建后的 Electron 入口覆盖。** 共享的 `@deepseek-ai/dsh-web-launcher` 原语（`packages/util/web-launcher`，设计为后续供 VS Code 扩展宿主消费）按固定顺序解析服务器命令——`DSH_BIN` 环境变量、嵌入闭包（`deploy/node_modules/@deepseek-ai/dsh/lib/bin.js`）、本检出目录的 CLI（构建产物 `lib/bin.js`，否则 tsx 源码启动）、PATH 上的 `dsh`——以 `web --host 127.0.0.1 --port 0` 启动，把 stdout 缓冲成行，解析就绪行（要求显式端口，因此被 chunk 切开的半行永远不会误匹配），报告日志回调失败且不中断 stdout 排空，并在轮询 HTTP 200 时用总期限约束每次 fetch 与等待。`src/main.ts` 只是 Electron 胶水：单实例锁、窗口（沙箱渲染进程、无 preload）、托盘、子进程生命周期。主进程与孤儿 reaper 会在退出时等待共享的 `@deepseek-ai/dsh-process-tree` 原语；Windows 会在 `taskkill /T /F` 命令结束后完成，POSIX 则只有在确认进程组已消失后才会完成。本地子进程后端复用同一终止实现。

**托盘常驻，而不是窗口生命周期。** 关闭窗口只隐藏它，服务器继续运行；托盘菜单重新打开窗口或退出（同时杀掉服务器）。二次启动聚焦已有窗口。打包版不需要 Node、`dsh` 或检出目录：嵌入闭包在 Electron-as-Node（`ELECTRON_RUN_AS_NODE=1`）下运行，且带 `--expose-internals`——harness 的 HMR 服务需要 Node 内部模块，而 `node-addon-require-builtin` 回退在 Electron 的 V8 下不可用（缺少 `GetAlignedPointerFromEmbedderData` 符号）。闭包内的原生插件（node-pty、koffi）是 N-API，无需针对 Electron 重新编译（`npmRebuild: false`）。

**打包用共享 lockfile deploy，而不是 `--legacy`。** `apps/desktop/closure` 是纯依赖 deploy root，其 110 项清单镜像 `python/sdk-runtime` 的 harness 闭包，外加 Web 专属 seam 包（`dsh-atomic-write`、`dsh-session-telemetry`、`dsh-session-telemetry-otel`、`dsh-session-title-first-message-llm`、`dsh-session-title-llm`、`dsh-spill`、`dsh-spill-local`、`dsh-spill-policy`）与 `@deepseek-ai/dsh` + `@deepseek-ai/dsh-frontend`。闭包同时列出 `@deepseek-ai/dsh-process-tree`，让 workspace 构建时能取得其编译产物。桌面源码（`src/main.ts`、`src/reaper.ts`）以包名导入 process-tree 与 web-launcher 两个 workspace 包，因此源码侧检查绝不依赖生成的桌面文件。产物构建会运行 `scripts/materialize-workspace-deps.mjs`，编译这两个原语并分别复制到 `lib/process-tree/` 与 `lib/web-launcher/`；随后 `scripts/fixup-import-paths.mjs` 把输出中的包 specifier 改写为 `../process-tree/index.js` 与 `../web-launcher/index.js`，因此打包应用通过普通相对路径加载产物，无需 node_modules。electron-builder 打包 `lib/`、`build/`（图标）与 `deploy/`，并配 `asarUnpack: deploy/** + lib/types/reaper.js + lib/process-tree/**`，因为 Electron-as-Node 子进程读不了 `app.asar` 内部；electron-builder 自身对 node_modules 的处理不会碰到闭包。`dist` 先跑完整仓库构建（`build:lib` + `build:web`），因为闭包复制的是构建产物而非源码。

## Alternatives considered

- **PWA「安装为应用」**——零新依赖、今天就能用，但窗口仍是浏览器、没有托盘、安装入口随浏览器而异；用户明确选择了真正的桌面外壳。
- **Tauri**——比 Electron 轻，但需要用户没有的 Rust 工具链；Electron 是纯 Node/pnpm，与仓库现状一致。
- **固定 3080 端口再解析 URL**——否决：`--port 0` + 就绪行免配置且永远不会与现有 `dsh web` 冲突（浏览器版与桌面版可并存）。
- **用 `@yao-pkg/pkg --sea` 打包整个 harness**（Python SDK 路线）——SEA 管线目前只支持 linux/macos，嵌入 web dist 资产还需要新的 pkg 资产管线；Electron-as-Node + `pnpm deploy` 闭包以零新增构建设施达成同样的自包含。
- **Windows 上只用 `child.kill()`**——它只终止直接子进程，后代可能存活。共享进程树原语改为等待 `taskkill /T /F` 命令完成；stdin 命令通道或 `GenerateConsoleCtrlEvent` 可以增加优雅 dispose 阶段，但 JSONL 的事件级持久化不依赖该阶段。

## Consequences

`pnpm --filter @deepseek-ai/dsh-desktop dev` 从检出目录以独立窗口打开 GUI；`dist` 产出 NSIS 安装包和免安装 exe，无需任何预装工具即可运行。启动器解析与组装后的 Electron 生命周期都有无密钥覆盖；生命周期路径会启动构建后的真实入口并持有真实服务器进程，而不是进入测试专用应用分支。服务器 stdout 以 `[dsh web]` 前缀转发；打包版不在别处写日志。v1 已知瑕疵：打包版内 harness 源码提示段会命名 unpacked deploy 树中一个存在但并非 harness 检出目录的路径（纯装饰，启动时无人读取）、调用目录即 workspace 的语义让开始菜单启动落在 shell 的 cwd、托盘图标主题是单一反色 PNG、外部链接一律经系统浏览器离开应用（前两项在 README 中亦有记录）。
