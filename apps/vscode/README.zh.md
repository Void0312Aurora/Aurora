# `dsh-vscode`

[English](README.md) | 中文

在**右侧栏**（Secondary Side Bar）中承载 DeepSeek Harness GUI 的 VS Code 扩展。它为每个窗口拉起一个受管的 `dsh web`，在 webview 视图中承载完整的 dsh 客户端栈，并通过扩展宿主把 webview 的 `/api` 流量桥接到服务器。与轻量的聊天参与者集成不同，它保留富 GUI 的全部能力：Plan Mode、trajectory 视图、slot 化工具卡以及设置页。

## 侧栏 shell

GUI 的宽屏 shell 把三个槽排成可拖拽的分栏，且拒绝让中栏低于 640px、侧栏保底 280px 且永不让出——这套几何在 300-400px 的编辑器侧栏里无法成立。因此本 webview 装载自己的 shell（`webview/shell/`）取代 [`ui-layout`](../../packages/client/ui-layout/README.md)。

这次替换不需要任何插件改动。`root` 只接受一个占用者，因此有且只有一个 shell 可装载，而这一个声明了**完全相同的三个子槽**（`sidebar`、`conversation`、`details`），kind 与 scope 一字不差；`ui-sidebar`、`ui-conversation` 及其下的每个 registrant 原样组合。差别在排布：窗格是叠起来的路由而非分栏，一次一个在前。无论当前路由为何，三个窗格都保持挂载——卸载会丢掉滚动位置、composer 草稿以及流式回合的实时订阅——由 CSS 选择谁在前。

`ctx.layout` 逐字实现宽屏 shell 的 `ILayout`，因此跨插件的面板手势照常工作，只是含义改变：切换侧栏变成在会话窗格与对话之间路由，打开详情变成把该窗格提到前面。

导航位于**原生 view title actions**，而非 webview 像素——后者是窄栏里最稀缺的资源。宿主会保留最新的目标路由，直到 webview 报告页面级监听器已就绪；webview 随后经 `webview/route-bridge.ts` 重放该路由，`NarrowLayoutService` 还会继续保留它，直到 root store 接入。因此 title action 能跨过初始页面与插件启动，而不是一条即发即弃的消息。

该 shell 住在本 app 而非 `packages/client`，因为 VS Code 侧栏是它唯一的消费者；出现第二个窄容器宿主时才值得把它提升为包。

### 让占用者放得下

占用者是按 736-800px 列画的，因此框架另外携带一套紧凑尺度。两种机制，按组件"以什么为参照测量自己"来选：

- **宿主变量**用于由容器决定尺寸的部分——composer 的侧边留白、卡片上限、dock 内缩、工具行间距与模型名上限，以及 hero 的留白和那个比卡片还宽的 glow。每一项都是读取方组件上的 `-host` 默认值（`var(--dsh-…-host, 桌面值)`），在框架处统一覆盖，宽屏 shell 的节奏不受影响。composer 工具行另外获得换行许可：它的控件是固定尺寸的，过了某个宽度只有第二行装得下。
- **媒体查询**用于以视口为锚的部分——设置模态（188px 导航轨变成内容上方的横向条，外观三卡从三行变一行）以及设置行 48px 的文字内缩。webview 本身就是一个 iframe，因此 `100vw` 与媒体查询看到的正是侧栏宽度；在浏览器壳里同样的规则只有窗口真的这么窄时才触发，这是正确的。

## 组成方式

```text
webview (browser)            extension host (Node)             dsh web
  PostMessageApiClient  ──▶   ApiBridge  ──▶  loopback fetch  ──▶  /api
  full dsh client stack  ◀──  postMessage  ◀──  SSE/JSON  ◀──────  /api
```

webview 的页面 origin 是 `vscode-webview://…`，会被服务器的 `/api` 浏览器信任栅栏拒绝。因此 webview 从不直接 fetch 服务器：它的传输（[`@deepseek-ai/dsh-client-connection`](../../packages/client/connection/README.md) 的 `PostMessageApiClient`）把请求 post 给扩展宿主，宿主再以服务器的回环 origin 重放——回环 Host 与任何非浏览器客户端一样通过栅栏。扩展宿主会保留服务器就绪状态，直到页面监听器安装完成，因此 bootstrap 不会把正常的启动间隔误判为不兼容。收到该信号后，bootstrap 在把传输公布给插件图之前只发送 `host.describe`，并要求 host 的 `protocolVersion` 等于内置客户端版本；版本更旧、更新、缺失或格式错误时会渲染不兼容 host 状态，客户端插件及其 stream 均不启动。桥把每个中继请求收束在该 origin 的 `/api/` 之下：绝对 URL、protocol-relative 或反斜杠 authority、非 API 路径在任何 fetch 之前即被拒绝，被注入的 webview 脚本无法借宿主的回环网络触达别的目标。兼容时的 GUI 就是普通 dsh 客户端栈，由 `webview/vite.config.ts` 静态打包（webview 的 CSP 禁止 fetch 插件 bundle，所以所有插件打进同一个 bundle），并通过共享的 `AppWebEntry` 内核以静态插件方式启动 roster。

扩展按需拉起：

```sh
dsh web --host 127.0.0.1 --port 0
```

经共享的 [`@deepseek-ai/dsh-web-launcher`](../../packages/util/web-launcher/README.md) 原语（桌面外壳用的是同一个），按 `DSH_BIN` → 内嵌闭包 → checkout → PATH 顺序解析 `dsh`。`--port 0` 意味着并行窗口永不冲突。启动、重启与 deactivate 由同一个串行生命周期事务拥有：它会在等待 disposer 前先解除 runtime 所有权，清理失败的启动，并在 teardown 开始时同步关闭发布，因此并发重启不会遗留服务器，和 deactivate 竞态的重启也不会在其后拉起新服务器。

## 原生交互

在 webview 之外，扩展宿主开自己的 mux 流（一个普通回环 wire 客户端——扩展宿主不是浏览器，直接通过 `/api` 信任栅栏），把 agent 的**审批**与**问答**请求呈现为可取消的编辑器原生控件。原生层只在同一项 `protocolVersion` 检查通过后启动；外部 `dsh` 不兼容时，GUI 启动和原生集成都保持关闭，并显示明确说明。审批使用 Allow/Reject QuickPick，问答使用带标签的选项/Other/Skip 加有校验的输入框；多选会在自定义文本旁保留已选选项。审批提示会用按会话、调用 id 与工具名限定的 `tool/call` view 缓存补充“这次调用要做什么”。由于 wire 是多客户端，哪个界面先应答哪个生效；请求在别处解决时，仍开着的提示会关闭且不会发送迟到应答。

## 编辑器上下文注入

扩展把你的编辑器上下文喂给模型，让 prompt 无需粘贴即可指代“这个文件”。在编辑器变化时（活动文件、文本、选区、诊断），一个防抖采样器构建有界读数——活动文件与范围、选区或游标窗口、错误/警告诊断——并经 `session.injectContext`（no-wakeup wire 方法）注入活动会话（它为会话的下一 step 暂存，绝不自行开启 turn）。签名与上次发送相同的读数会被抑制。会话变为活动状态时采样器立即注入；桥也会从 `session.prompt` 提取显式 session，并把该 session 的首个请求拦到同一个 single-flight 注入尝试结算之后。面板取得焦点期间扩展保留最后一个有效编辑器读数，因此打开面板不会丢失此前打开的文件。后台编辑器 nudge 仍面向 host 跟踪的会话（最近运行，否则第一个见到的）；即使尚无 webview→host 选择信号，首个桥接 prompt 也会精确命中其显式 session。

## 命令

- **DeepSeek Harness: Focus Sidebar**——显示该视图（VS Code 在首次显示时解析它，从而启动服务器）。
- **DeepSeek Harness: Show Conversation** / **Show Sessions**——路由前台窗格；两者都是该视图的 title action，最新请求会在 webview 就绪后重放。
- **DeepSeek Harness: Restart Server**——串行执行受管服务器的树杀与重启。视图会保留：桥经活的 getter 解析服务器 origin，webview 自行重连到新端口。

## Windows

Windows 没有 harness 隔离后端，CLI 默认的 `workspace-write` 权限模式在那里无法启动。未设置 `DSH_PERMISSION_MODE` 时启动器兜底为 `danger-full-access`（审批提示禁用）并打印警告；显式设置 `DSH_PERMISSION_MODE` 可覆盖。这与桌面外壳采用的兜底一致。

## 构建

```sh
pnpm --filter dsh-vscode run build       # host bundle (tsdown) + webview bundle (vite)
pnpm --filter dsh-vscode run build:host  # extension host only
pnpm --filter dsh-vscode run build:webview
```

host 构建产出一个自包含的 `dist/extension.js`（workspace 运行时导入被内联；只有 VS Code API 保持 external）。webview 构建产出 `dist/webview/webview.js` 与 `webview.css`，经 `asWebviewUri` 提供。

## 打包（自包含 vsix）

```sh
pnpm --filter dsh-vscode run package    # packs a vsix for the host platform
```

`package` 跑完整仓库构建，物化 `deploy/`（`dsh-vscode-closure` 纯依赖 deploy root——与桌面外壳所载相同的自包含 `dsh web` 包），构建扩展，并经 [scripts/package-vsix.mjs](scripts/package-vsix.mjs) 对一个平台目标运行 `vsce package --no-dependencies`。目标默认取宿主平台；在环境中设置 `DSH_VSIX_TARGET`（如 `linux-x64`、`darwin-arm64`）可覆盖——由 Node 脚本读取，因此在各操作系统上行为一致，无需 POSIX shell 语法。vsix 的运行时位于 `dist/`、`deploy/` 与 `media/`，并包含 [.vscodeignore](.vscodeignore) 保留的扩展 manifest、双语 README 与许可证；源码和开发用 `node_modules` 树不会进入包内。

打包后的扩展不需要 Node、不需要 `dsh`、也不需要 checkout：启动器的内嵌闭包分支在 **VS Code 自己的 Electron-as-Node** 下运行捆绑的 CLI（`ELECTRON_RUN_AS_NODE=1` 加 `--expose-internals`，正是桌面外壳的机制，`process.execPath` 即扩展宿主的 Electron）。闭包的原生插件（node-pty、koffi）是 N-API，无需重新编译。

由于闭包携带平台原生插件，vsix 是**按平台**的（`vsce package --target <target>`）；CI 矩阵按 `win32-x64`、`linux-x64`、`darwin-x64`、`darwin-arm64` 等各打一个。没有 `deploy/` 的 dev checkout 会落到 checkout 的已构建 CLI 或 PATH 上的 `dsh`，因此 `pnpm --filter dsh-vscode run build` 加 Extension Development Host 无需打包即可工作。

## 测试

`tests/` 无密钥地在注入的客户端、UI、spawn 与调度器上覆盖纯扩展宿主逻辑：进程 runtime（`runtime.spec.ts`）、并发 restart/deactivate 下的串行所有权（`runtime-lifecycle.spec.ts`）、postMessage↔fetch 中继及其 SSRF 收束（`bridge.spec.ts`）、服务器就绪与启动前协议门禁（`webview-bootstrap.spec.ts`）、ready/replay 路由、面板 HTML/CSP、roster 一致性、原生交互、活动会话跟踪、IDE 上下文采样和串行 context feed。浏览器通道通过真实 `panelHtml()` 文档及已交付的 CSP 提供构建出的 `dist/webview`；`sidebar.snapshot.ts` 以 259px 启动无密钥 fixture，并记录路由、交互 composer、代表性工具行以及横向约束。`pnpm run test:vscode:electron` 还会在隔离的 Extension Development Host 中加载构建后的扩展，只把 LLM 替换为录制重放并启动生产 `dsh web` 组合，驱动构建后的 webview 发送 prompt，要求生产 JSONL 中 IDE 上下文早于 prompt 与首个 request header，并重启受管服务器。两个通道都不声称覆盖真实提供方 transcript。

## Known Limitations and Deferred Work

- **上下文注入面向启发式会话**——活动会话在 host 侧跟踪（最近运行，否则第一个见到）；当有多个会话附着时，在 webview→host 活动会话信号出现前，注入可能命中与面板所显示不同的会话。
- **原生审批提示与面板内提示并存**——两个界面都会显示每个审批/问答；v1 不抑制任何一个。按窗口开关推迟到扩展有设置面后。
- **自包含打包假定 VS Code 的 Node 在 harness 引擎范围内**——内嵌闭包在 VS Code 的 Electron-as-Node 下运行，其必须满足 harness `node ^22.19 || >=24` 范围。若某 VS Code 构建携带的 Node 越界，则需改用基于 PATH 的 vsix（不含 `deploy/`，依赖已装的 `dsh`）；为目标 VS Code 版本确认该范围是一个发布关卡。
- **vsix 单独签名/发布**——`package` 按平台产出未签名 vsix；marketplace 签名与发布（`vsce publish`）是发布步骤，本地打包不需要，故 `keytar`/`vsce-sign` 原生构建被拒绝。
- **每窗口一个视图**——扩展只承载单个侧栏视图；不支持同时多个 GUI 界面。
- **真实提供方的编辑器 transcript（文本记录）仍需手动核验**——浏览器快照证明，构建出的 webview 可在 259px 下渲染 fixture 助手内容、交互 composer 与工具行且没有根级横向溢出；Extension Host 通道则用 fixture 服务器证明激活和原生集成。两者都没有在编辑器中执行真实提供方轮次。
