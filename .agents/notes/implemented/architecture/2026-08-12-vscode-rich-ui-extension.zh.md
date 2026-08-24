# Agent Note：dsh-vscode —— 富 UI 的 VS Code 面板

Status: implemented

[English](2026-08-12-vscode-rich-ui-extension.md) | 中文

> Scope：新的产品装配 `apps/vscode`（workspace 名 `dsh-vscode`——未加 scope，因为 `vsce` 拒绝带 scope 的扩展 `name`；`deepseek-ai` publisher 使扩展 id 为 `deepseek-ai.dsh-vscode`），在 VS Code webview 面板中承载完整 DeepSeek Harness Web GUI —— 每窗口一个受管 `dsh web`、把完整 dsh 客户端栈静态打包进 webview，以及跨扩展宿主边界的 postMessage↔fetch 桥。本笔记覆盖面板/服务器/桥的基础；编辑器侧原生集成在后续阶段落地。

> 与社区 `dsh-external/dsh-vscode` 的关系：那个扩展是原生 VS Code Chat Participant（`@dsh`），刻意不做 trajectory 页与嵌入式 Web UI。本装配占据相反的点 —— 通过承载真实客户端栈保留富 GUI（Plan Mode、trajectory、slot 化工具卡、设置）。两者互补，只共享 `dsh web` 服务器契约。

## 问题

Web GUI 是产品最丰富的界面，桌面外壳已证明一个客户端壳可以掌管 `dsh web` 服务器的生命周期。VS Code 用户希望这套 GUI 就在编辑器旁边，随后再叠加编辑器原生能力。webview 就是浏览器，原则上 GUI 可原样运行 —— 但两个事实挡住了朴素移植。其一，webview 的页面 origin 是 `vscode-webview://…`，会被服务器的 `/api` 浏览器信任栅栏拒绝（栅栏要求回环 Host 或同源 `Origin`；DNS-rebinding 防御正是其要义）。其二，webview 的 CSP 禁止从服务器 fetch 插件 bundle，因此客户端模块系统默认的"每插件 fetch 一个 bundle"装载路径无法运行。

## 决策

**扩展宿主掌管服务器并代理每一个 `/api` 字节；webview 从不接触网络。** `ServerRuntime`（`apps/vscode/src/runtime.ts`）经共享的 `@deepseek-ai/dsh-web-launcher` 原语 spawn `dsh web --host 127.0.0.1 --port 0` —— 与桌面外壳同一套解析/就绪/HTTP 轮询逻辑，在同一批工作中被抽取到 `packages/util/web-launcher` —— 并在 deactivate 时经 `@deepseek-ai/dsh-process-tree` 树杀。webview 的传输是新的 `PostMessageApiClient`（`packages/client/connection`，Web 与 Fixture 之外的第三个平台子类），把每个请求经嵌入器端口 post 出去；`ApiBridge`（`apps/vscode/src/bridge.ts`）以服务器的回环 origin 重放，并把每个请求收束在该 origin 的 `/api/` 前缀之下（`resolveApiTarget`）——webview 可能运行被注入的脚本，而宿主握有回环网络触达，页面不得借它去别的目标（绝对 URL、protocol-relative 或反斜杠 authority、非 API 路径在任何 fetch 之前即被拒绝）。回环 Host 与任何非浏览器客户端一样通过栅栏，因此栅栏本身分毫未改 —— 桥正是 GUI 能触达服务器的原因，并报告 `isLoopback: true`，因为 wire 客户端是扩展宿主的 fetch，而非 webview 页面。桥与两个宿主侧 wire 客户端都经活的 getter 解析 origin，从不捕获特定服务器实例，因此 restart 命令换掉 `ServerRuntime` 后每个消费者都跟到新端口（webview 经同一座桥重连）。

**GUI 被静态打包，并通过未改动的壳内核启动。** `AppWebEntry` 新增一个 seam —— 经模块系统既有 `registerStatic` 路径注册的 `staticPlugins` map —— 让 webview 在构建期把每个插件实现交给它，而非一张 fetch 图。`webview/vite.config.ts` 把 roster（`apps/cli/config/web.cordis.yml` 的 `dshClient` 行去掉 dev-only hmr，加一个 VS Code 主题适配器）打成一对资源，经 `asWebviewUri` 在严格 CSP 下提供（`script-src` 钉在扩展资源 origin，无内联脚本或运行时表达式求值）。扩展自有的 Loader overlay 用面板内 browse 后端替换宿主 OS 目录选择器，而静态 roster 携带与之匹配的客户端半边。主题适配器经既有 `ThemeService.register()` 把编辑器的 `--vscode-*` 变量映射到客户端的 `--dsw-alias-*` token，使 GUI 跟随编辑器配色主题。

**有两条浏览器壳从不会遇到的约束，使这份 bundle 不同于 `apps/web` 的，且违反任一条都会让面板整片空白。** 其一，*library* 构建（`build.lib`，webview 需要它产出一对具名资源）不替换 `process.env.NODE_ENV`——Vite 假定库会被下游再打包一次；而这份不会被任何人再打包，于是 React 的 CJS 入口在模块顶层抛 `process is not defined`，除非 `define` 显式提供它。其二，面板 CSP 不含 `'unsafe-eval'`，而 vendored loader 在模块顶层用 `new Function` 构造它的 `!!js` 求值器——`webview/loader-config-utils-stub.ts` 按解析路径替换该模块（`vendor/loader` 以相对路径引用它，specifier 别名匹配不到），把求值器换成"抛错"而非"存在"，这在此处是正确的：webview 从静态 roster 与静态 boot 图启动，没有 `!!js` 节点能抵达它。`font-src` 另需允许 `data:`，因为单张样式表内联了自己的 webfont。Zod 的可选 JIT 探测仍会在 console 留下一条可恢复的 CSP 违规；它随即回落到解释执行，校验依然正确。

**窗口是隔离单位。** 每窗口一个 `ServerRuntime`（`--port 0` 保证窗口之间以及与独立 `dsh web` 之间不冲突）；第一个 workspace folder 作为服务器 cwd，harness 据此采纳为默认项目根。面板在后台启动服务器且从不阻塞其上 —— webview 自己的连接循环会在服务器就绪时重连。

## 考虑过的替代方案

- **VS Code Chat Participant（社区 `dsh-vscode` 路线）** —— 原生且轻，但 Chat API 表达不了富 GUI（trajectory、Plan Mode、slot 工具卡）；那个扩展直言了这一省略。此处正因富 GUI 是本装配的存在理由而否决它。
- **webview 直接 fetch 服务器** —— 不可能：`vscode-webview://` origin 过不了 `/api` 信任栅栏，而为它放宽栅栏会重新打开栅栏所堵的 DNS-rebinding 漏洞。
- **运行时 fetch 插件 bundle（浏览器壳默认）** —— webview CSP 禁止远程脚本与内联执行；静态单 bundle 是 CSP 干净的形态，也省掉浏览器壳启动时付的服务器往返。
- **在 VS Code 内复用桌面 Electron 壳** —— VS Code 本身就是 Electron 宿主，嵌套壳无法挂载。可复用的是启动器，这也是它被移入共享包而非拷贝的原因。
- **给面板 CSP 加 `'unsafe-eval'`** —— 这是绕过 loader 顶层 `new Function` 的一行改法，否决理由与桥收束请求目标相同：webview 被当作可能运行注入脚本来对待，为省一个 stub 模块而交给它字符串转代码的能力，是错误的取舍。

## 后果

启动器抽取使 `apps/desktop` 成为 `@deepseek-ai/dsh-web-launcher` 的消费者（其内联启动器与单测套件迁入共享包）。`PostMessageApiClient`、`AppWebEntry` 的静态插件 seam 与主题适配器都有无密钥覆盖：传输测试钉住一元/SSE/abort/清理行为与平台选择；注入的 spawn/fetch/kill seam 覆盖扩展宿主的生命周期、中继收束、面板 CSP 与静态 roster 一致性。浏览器通道通过已交付 CSP 提供构建后的 webview，并要求 React 挂载且无未捕获错误。`pnpm run test:vscode:electron` 进一步覆盖已装配边界：它在隔离的 Extension Development Host 中加载 `dist/extension.js`，以确定性 replay 适配器对生产 CLI 打开面板，验证精确会话的上下文准入，将稳定后的 VS Code 原生问题控件与已提交的 aria golden 比较，通过该原生控件回答，等待替代代次就绪，并证明第二个桥接 prompt 在替代代次中完成。真实提供方的编辑器 transcript 仍需手工核验；确定性通道不声称覆盖它。宿主 bundle 内联 workspace 运行时导入，只保留 `vscode` 与 Node 内建模块为 external。打包后的按平台 vsix 携带自身物化的 `dsh web` 闭包，因此无需预装 `dsh`；未打包的开发 checkout 则保留启动器的 `DSH_BIN`、checkout 与 PATH 兜底。
