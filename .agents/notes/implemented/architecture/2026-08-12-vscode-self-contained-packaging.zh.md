# Agent Note：dsh-vscode 自包含打包

Status: implemented

[English](2026-08-12-vscode-self-contained-packaging.md) | 中文

> Scope：`apps/vscode` 的打包方案——一个按平台的 vsix，把整个 `dsh web` 服务器作为物化闭包携带，并在 VS Code 自己的 Electron-as-Node 下运行，使扩展无需预装 Node、`dsh` 或 checkout。复用桌面外壳的闭包机制（[桌面 note](2026-08-04-dsh-desktop-electron-shell.md)）。

## 问题

没有 `dsh web` 服务器扩展就无用，而要求用户另行安装 harness 违背一键 marketplace 安装的初衷。桌面外壳已解决"把整个服务器作为自包含包携带并在 Electron-as-Node 下运行"；vsix 需要同样的东西，适配 VS Code 的打包（`vsce`）与它的扩展宿主作为 Electron-as-Node 运行时。

## 决策

**vsix 携带物化的 `dsh web` 闭包，而非依赖树。** `apps/vscode/closure/package.json`（`dsh-vscode-closure`）是纯依赖 deploy root，其清单镜像 `apps/desktop/closure`——harness 闭包加 Web 专属 seam 包、CLI 应用与 web 前端。`pnpm run deploy:closure` 以 `pnpm deploy` 物化到 `apps/vscode/deploy/`，即打包扩展运行的自包含服务器。`.vscodeignore` 只携带 `dist/`、`deploy/` 与 `media/`；无 `node_modules`。

**扩展宿主就是 Electron-as-Node 运行时——没有新机制。** 启动器的内嵌闭包分支已在 `process.execPath` 下以 `ELECTRON_RUN_AS_NODE=1` 加 `--expose-internals` spawn `<appDir>/deploy/node_modules/@deepseek-ai/dsh/lib/bin.js`。在扩展里 `process.execPath` 是 VS Code 的 Electron，`appDir` 是扩展根，因此打包后带 `deploy/` 的 vsix 无需改代码即走该分支；共享的 `@deepseek-ai/dsh-web-launcher` 已承载并测试该解析。没有 `deploy/` 的 dev checkout 会落到 checkout CLI 或 PATH，故 Extension Development Host 未打包也能工作。

**与桌面外壳不同，扩展宿主 bundle 无需 materialize/fixup。** 桌面 main 用 `tsc` 编译，必须把它的 workspace 原语拷进 `lib/` 并改写 specifier；扩展宿主是 `tsdown` bundle，已把 `dsh-process-tree` 与 `dsh-web-launcher` 内联进自包含的 `dist/extension.js`。只有服务器闭包被物化。

**vsix 按平台。** 闭包携带 N-API 原生插件（node-pty、koffi），因此 `vsce package --target <target>` 每平台产一个 vsix；CI 矩阵打一整套。原生插件与 Electron-as-Node ABI 兼容，无需重编译。

## 考虑过的替代方案

- **要求预装 `dsh`**——一个纯 JS 的薄 vsix，依赖 PATH；最简单，但 marketplace 用户期望装完即用。保留为文档化的兜底，供 Node 越界的 VS Code 构建使用。
- **在 vsix 里捆绑 Node**——冗余：扩展宿主本就是一个能作为 Node 运行的 Electron，正是桌面外壳所利用的。
- **单个通用 vsix**——有原生插件时不可能；平台目标是必需的。
- **直接复用 `apps/desktop/closure`**——`pnpm deploy` 把一个包物化到其自己的 deploy 目录；一个平行闭包包是每个自包含装配遵循的同一模式（桌面与 Python 运行时各拥有一个）。

## 后果

`DSH_VSIX_TARGET=<target> pnpm --filter @deepseek-ai/dsh-vscode run package` 产出自包含的按平台 vsix。闭包作为 workspace 成员解析（`apps/vscode/closure`，与桌面闭包一样被 knip 忽略），`deploy/` 被 gitignore。本设计携带的唯一发布关卡：内嵌闭包在 VS Code 的 Electron-as-Node 下运行，其必须满足 harness `node ^22.19 || >=24` 引擎范围——携带更旧 Node 的 VS Code 构建需改用基于 PATH 的兜底 vsix，而为目标 VS Code 版本确认该范围是打包期检查，非单测能断言。Marketplace 签名/发布是单独发布步骤；`keytar` 与 `@vscode/vsce-sign` 原生构建在 `pnpm-workspace.yaml` 中被拒绝，因为 `vsce package --no-dependencies` 两者都不需要。实际的 `vsce package` 运行与按平台矩阵在 CI/发布中，与桌面 `dist` 流水线一样——仓库携带配置与闭包清单，由闭包解析与启动器自身受测的解析顺序验证。
