# Agent Note：dsh-vscode —— 富 UI 的 VS Code 面板

Status: implemented

[English](2026-08-12-vscode-rich-ui-extension.md) | 中文

> Scope：新的产品装配 `apps/vscode`（workspace 名 `dsh-vscode`——未加 scope，因为 `vsce` 拒绝带 scope 的扩展 `name`；`deepseek-ai` publisher 使扩展 id 为 `deepseek-ai.dsh-vscode`），在 VS Code webview 面板中承载完整 DeepSeek Harness Web GUI —— 每窗口一个受管 `dsh web`、把完整 dsh 客户端栈静态打包进 webview，以及跨扩展宿主边界的 postMessage↔fetch 桥。本笔记负责面板/服务器/桥基础；[原生交互](2026-08-12-vscode-native-interactions.md)与[编辑器上下文注入](2026-08-12-vscode-ide-context-injection.md)分别负责对应的编辑器侧集成。打包闭包与 vsix 细节另见自包含打包 note。

> 与社区 `dsh-external/dsh-vscode` 的关系：那个扩展是原生 VS Code Chat Participant（`@dsh`），刻意不做 trajectory 页与嵌入式 Web UI。本装配占据相反的点 —— 通过承载真实客户端栈保留富 GUI（Plan Mode、trajectory、slot 化工具卡、设置）。两者互补，只共享 `dsh web` 服务器契约。

## 问题

Web GUI 是产品最丰富的界面，桌面外壳已证明一个客户端壳可以掌管 `dsh web` 服务器的生命周期。VS Code 用户希望这套 GUI 与编辑器原生能力就在编辑器旁边。webview 就是浏览器，原则上 GUI 可原样运行 —— 但两个事实挡住了朴素移植。其一，webview 的页面 origin 是 `vscode-webview://…`，会被服务器的 `/api` 浏览器信任栅栏拒绝（栅栏要求回环 Host 或同源 `Origin`；DNS-rebinding 防御正是其要义）。其二，webview 的 CSP 禁止从服务器 fetch 插件 bundle，因此客户端模块系统默认的“每插件 fetch 一个 bundle”装载路径无法运行。

## 决策

**扩展宿主掌管服务器并代理每一个 `/api` 字节；webview 从不接触网络。** `ServerRuntime`（`apps/vscode/src/runtime.ts`）经共享的 `@deepseek-ai/dsh-web-launcher` 原语 spawn `dsh web --host 127.0.0.1 --port 0`，使用与桌面外壳相同的解析/就绪/HTTP 轮询逻辑，并经 `@deepseek-ai/dsh-process-tree` 树杀。每次启动尝试拥有自身的子进程与监听器；spawn 后的任何失败都会先终止该子进程，再允许重试替换。`RuntimeLifecycle`（`apps/vscode/src/lifecycle.ts`）拥有当前代次，在重启期间保留面板，并向 `ApiBridge` 与原生 wire 客户端提供当前 origin 解析器，任何消费者都不会保留已销毁的服务器。webview 的 `PostMessageApiClient`（`packages/client/connection`，Web 与 Fixture 之外的第三个平台子类）把每个请求经嵌入器端口 post 出去；`ApiBridge`（`apps/vscode/src/bridge.ts`）以当前服务器的回环 origin 重放。回环 Host 与任何非浏览器客户端一样通过栅栏，因此栅栏本身分毫未改 —— 桥正是 GUI 能触达服务器的原因，并报告 `isLoopback: true`，因为 wire 客户端是扩展宿主的 fetch，而非 webview 页面。

**GUI 被静态打包，并通过未改动的壳内核启动。** `AppWebEntry` 新增一个 seam —— 经模块系统既有 `registerStatic` 路径注册的 `staticPlugins` map —— 让 webview 在构建期把每个插件实现交给它，而非一张 fetch 图。`webview/vite.config.ts` 把 roster（`apps/cli/config/web.cordis.yml` 的 `dshClient` 行去掉 dev-only hmr，加一个 VS Code 主题适配器）打成一对资源，经 `asWebviewUri` 在严格 CSP 下提供（`script-src` 钉在扩展资源 origin，无内联脚本）。主题适配器经既有 `ThemeService.register()` 把编辑器的 `--vscode-*` 变量映射到客户端的 `--dsw-alias-*` token，使 GUI 跟随编辑器配色主题。

**窗口是隔离单位。** 每个窗口只有一个当前 `ServerRuntime`（`--port 0` 保证窗口之间以及与独立 `dsh web` 之间不冲突）；第一个 workspace folder 作为服务器 cwd，harness 据此采纳为默认项目根。启动保持异步，webview 的连接循环会在服务器就绪或重启发布替代代次时重连。

## 考虑过的替代方案

- **VS Code Chat Participant（社区 `dsh-vscode` 路线）** —— 原生且轻，但 Chat API 表达不了富 GUI（trajectory、Plan Mode、slot 工具卡）；那个扩展直言了这一省略。此处正因富 GUI 是本装配的存在理由而否决它。
- **webview 直接 fetch 服务器** —— 不可能：`vscode-webview://` origin 过不了 `/api` 信任栅栏，而为它放宽栅栏会重新打开栅栏所堵的 DNS-rebinding 漏洞。
- **运行时 fetch 插件 bundle（浏览器壳默认）** —— webview CSP 禁止远程脚本与内联执行；静态单 bundle 是 CSP 干净的形态，也省掉浏览器壳启动时付的服务器往返。
- **在 VS Code 内复用桌面 Electron 壳** —— VS Code 本身就是 Electron 宿主，嵌套壳无法挂载。可复用的是启动器，这也是它被移入共享包而非拷贝的原因。

## 后果

启动器抽取使 `apps/desktop` 成为 `@deepseek-ai/dsh-web-launcher` 的消费者。`PostMessageApiClient`、`AppWebEntry` 的静态插件 seam 与主题适配器都有无密钥覆盖；扩展宿主测试覆盖失败启动清理、重启/origin 重绑定、中继、面板 CSP 与 roster 一致性。`pnpm run test:vscode:electron` 在隔离的 Extension Development Host 中加载构建后的 `dist/extension.js`，对确定性的本地服务器打开已装配面板，验证上下文注入与一次原生审批，重启服务器，并比较用户可见结果快照。宿主 bundle 内联 workspace 运行时导入，只保留 `vscode` 与 Node 内建模块为 external。扩展仍依赖启动器经 `DSH_BIN`、checkout 或 PATH 解析出 `dsh`；三者皆无的机器会在面板中收到启动错误。
