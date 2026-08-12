# `dsh-vscode`

[English](README.md) | 中文

在编辑器面板中承载完整 DeepSeek Harness Web GUI 的 VS Code 扩展。它为每个窗口拉起一个受管的 `dsh web`，在 webview 中承载完整的 dsh 客户端栈，并通过扩展宿主把 webview 的 `/api` 流量桥接到服务器。与轻量的聊天参与者集成不同，本面板保留富 GUI 的全部能力：Plan Mode、trajectory 视图、slot 化工具卡以及设置页。

## 组成方式

```text
webview (browser)            extension host (Node)             dsh web
  PostMessageApiClient  ──▶   ApiBridge  ──▶  loopback fetch  ──▶  /api
  full dsh client stack  ◀──  postMessage  ◀──  SSE/JSON  ◀──────  /api
```

webview 的页面 origin 是 `vscode-webview://…`，会被服务器的 `/api` 浏览器信任栅栏拒绝。因此 webview 从不直接 fetch 服务器：它的传输（[`@deepseek-ai/dsh-client-connection`](../../packages/client/connection/README.md) 的 `PostMessageApiClient`）把每个请求 post 给扩展宿主，宿主再以服务器的回环 origin 重放——回环 Host 与任何非浏览器客户端一样通过栅栏。GUI 本身就是普通 dsh 客户端栈，由 `webview/vite.config.ts` 静态打包（webview 的 CSP 禁止 fetch 插件 bundle，所以所有插件打进同一个 bundle），并通过共享的 `AppWebEntry` 内核以静态插件方式启动 roster。

扩展按需拉起：

```sh
dsh web --host 127.0.0.1 --port 0
```

经共享的 [`@deepseek-ai/dsh-web-launcher`](../../packages/util/web-launcher/README.md) 原语（桌面外壳用的是同一个），按 `DSH_BIN` → 内嵌闭包 → checkout → PATH 顺序解析 `dsh`。`--port 0` 意味着并行窗口永不冲突。扩展宿主 deactivate 时受管服务器会被（树）终止。

## 原生交互

在 webview 之外，扩展宿主开自己的 mux 流（一个普通回环 wire 客户端——扩展宿主不是浏览器，直接通过 `/api` 信任栅栏），把 agent 的**审批**与**问答**请求呈现为可取消的编辑器原生控件：审批使用带 Allow/Reject 的 QuickPick，问答使用 QuickPick 或输入框。审批提示会用按会话、调用 id 与工具名限定的 `tool/call` view 缓存补充“这次调用要做什么”。由于 wire 是多客户端，这与 webview 面板内的提示并存：哪个界面先应答哪个生效；请求在别处解决时，仍开着的提示会关闭且不会发送迟到应答。

## 编辑器上下文注入

扩展把你的编辑器上下文喂给模型，让 prompt 无需粘贴即可指代“这个文件”。在编辑器变化时（活动文件、文本、选区、诊断），一个防抖采样器构建有界读数——活动文件与范围、选区或游标窗口、错误/警告诊断——并经 `session.injectContext`（no-wakeup wire 方法）注入活动会话（它为会话的下一 step 暂存，绝不自行开启 turn）。签名与上次发送相同的读数会被抑制。会话变为活动状态时采样器立即注入；面板取得焦点期间扩展保留最后一个有效编辑器读数，因此打开面板不会丢失此前打开的文件。目标会话从 host 流跟踪（最近运行的会话，否则第一个见到的）；精确的“用户正在看的会话”选择有待 webview→host 信号。

## 命令

- **DeepSeek Harness: Open Panel**——（必要时）启动服务器并在编辑器旁显示 GUI 面板。
- **DeepSeek Harness: Restart Server**——树杀并重启受管服务器，同时保留面板；桥与原生客户端会动态解析替换后的 origin。

## Windows

Windows 没有 harness 隔离后端，CLI 默认的 `workspace-write` 权限模式在那里无法启动。未设置 `DSH_PERMISSION_MODE` 时启动器兜底为 `danger-full-access`（审批提示禁用）并打印警告；显式设置 `DSH_PERMISSION_MODE` 可覆盖。这与桌面外壳采用的兜底一致。

## 构建

```sh
pnpm --filter dsh-vscode run build       # host bundle (tsdown) + webview bundle (vite)
pnpm --filter dsh-vscode run build:host  # extension host only
pnpm --filter dsh-vscode run build:webview
```

host 构建产出一个自包含的 `dist/extension.js`（workspace 运行时导入被内联；只有 VS Code API 与 Node 内建模块保持 external）。webview 构建产出 `dist/webview/webview.js` 与 `webview.css`，经 `asWebviewUri` 提供。

## 打包（自包含 vsix）

```sh
pnpm --filter dsh-vscode run package    # packs a vsix for the host platform
```

`package` 跑完整仓库构建，物化 `deploy/`（`dsh-vscode-closure` 纯依赖 deploy root——与桌面外壳所载相同的自包含 `dsh web` 包），构建扩展，并经 [scripts/package-vsix.mjs](scripts/package-vsix.mjs) 对一个平台目标运行 `vsce package --no-dependencies`。目标默认取宿主平台；在环境中设置 `DSH_VSIX_TARGET`（如 `linux-x64`、`darwin-arm64`）可覆盖——由 Node 脚本读取，因此在各操作系统上行为一致，无需 POSIX shell 语法。vsix 的运行时位于 `dist/`、`deploy/` 与 `media/`，并包含 [.vscodeignore](.vscodeignore) 保留的扩展 manifest、双语 README 与许可证；源码和开发用 `node_modules` 树不会进入包内。

打包后的扩展不需要 Node、不需要 `dsh`、也不需要 checkout：启动器的内嵌闭包分支在 **VS Code 自己的 Electron-as-Node** 下运行捆绑的 CLI（`ELECTRON_RUN_AS_NODE=1` 加 `--expose-internals`，正是桌面外壳的机制，`process.execPath` 即扩展宿主的 Electron）。闭包的原生插件（node-pty、koffi）是 N-API，无需重新编译。

由于闭包携带平台原生插件，vsix 是**按平台**的（`vsce package --target <target>`）；CI 矩阵按 `win32-x64`、`linux-x64`、`darwin-x64`、`darwin-arm64` 等各打一个。没有 `deploy/` 的 dev checkout 会落到 checkout 的已构建 CLI 或 PATH 上的 `dsh`，因此 `pnpm --filter dsh-vscode run build` 加 Extension Development Host 无需打包即可工作。

## 测试

`tests/` 无密钥覆盖扩展宿主逻辑：进程事务（`runtime.spec.ts`）、重启与 origin 重绑定（`lifecycle.spec.ts`）、postMessage↔fetch 中继（`bridge.spec.ts`）、可取消原生控件（`native-ui.spec.ts`）、上下文目标、面板 HTML/CSP，以及静态 roster 一致性。`pnpm run test:vscode:electron` 在隔离的 Extension Development Host 中加载构建后的 `dist/extension.js`，对确定性的本地服务器打开已装配面板，验证此前打开的编辑器会被注入、应答一次原生审批、重启服务器，并比较用户可见结果快照。

## 已知限制与后续工作

- **上下文注入面向启发式会话**——活动会话在 host 侧跟踪（最近运行，否则第一个见到）；当有多个会话附着时，在 webview→host 活动会话信号出现前，注入可能命中与面板所显示不同的会话。
- **原生审批提示与面板内提示并存**——两个界面都会显示每个审批/问答；v1 不抑制任何一个。按窗口开关推迟到扩展有设置面后。
- **每窗口一个面板**——扩展承载单个 GUI 面板；不支持同时多个面板。
