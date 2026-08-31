# Agent Note：VS Code 侧栏 shell——替换 root 占用者而非其下的插件

Status: implemented

[English](2026-08-14-vscode-sidebar-shell.md) | 中文

> Scope：把 `apps/vscode` 从编辑器列中的 webview 面板迁到右侧栏（Secondary Side Bar）的 webview 视图，以及使既有 GUI 在 300-400px 下可组合、且不触碰任何下游插件的 shell 替换。建立在[富 UI 扩展](2026-08-12-vscode-rich-ui-extension.md)之上，后者拥有面板/服务器/桥基础。

## 问题

把完整 web GUI 塞进编辑器 tab 是把富界面搬进 VS Code 最快的路径，而它在两个层面都是错的形态。它占据一整列编辑器，与该集成存在的理由——"就我正在读的文件问一句"——相冲突。而它承载的 GUI 是三栏桌面布局：[columns.ts](../../../../packages/client/ui-layout/src/client/columns.ts) 把 `CENTER_MIN` 定为 640px、`SIDEBAR_MIN` 定为 280px，并注明侧栏永不让出，也没有任何 breakpoint 会折叠它。在 300px 侧栏里，对话列会被挤到零。

"为侧栏重做 UI"最直观的读法是重写呈现层——客户端 AGENTS.md 甚至为此背书，称组件是消耗品、"预期被整体重写"。但为一个布局问题付出二十个客户端插件包的代价，太贵。

## 决策

**替换 `root` 的占用者，而非其下的插件。** `SlotsService` 在构造时把 `root` 声明为单占用槽，第二次注册会在装载时硬失败；这一互斥正是第二个 shell 需要的接缝。`apps/vscode/webview/shell/` 把一个单窗格框架注册进 `root`，并声明与宽屏 shell **完全相同的三个子槽**——`sidebar`、`conversation`、`details`，kind 与 scope 一字不差。槽名就是组合契约，因此 `ui-sidebar`、`ui-conversation` 及其下的每个 registrant 无改动即可组合进侧栏。由 roster 挑选 shell：浏览器应用装 `ui-layout`，本 webview 装自己的。

**窗格是叠起来的路由，且全部保持挂载。** 一次一个在前，由 CSS 依据 shell 自有 store 中的路由来选择。卸载其余窗格会丢掉滚动位置、composer 草稿与流式回合的实时订阅，因此用 `display: none` 隐藏。`ctx.layout` 逐字实现宽屏 shell 的 `ILayout`——三个方法——只改变含义：切换侧栏在会话窗格与对话之间路由，打开详情把该窗格提到前面。

**导航是原生的。** 视图贡献进 `viewsContainers.secondarySidebar`，该能力在 VS Code 1.106 定案，我们的 `^1.125` 引擎范围可直接使用，因此扩展无需用户拖动即落在右侧栏。title actions 承担导航行：它们不消耗 webview 像素——窄栏中最稀缺的资源。宿主会保留最新目标路由，直到 webview 报告页面监听器已经安装；页面级路由通道随后把该值重放给 `webview/route-bridge.ts`，`NarrowLayoutService` 再继续保留，直到 root store 接入。路由仍独立于 API bridge 的消息联合类型，同时能跨过页面与插件启动。

**服务器由单一生命周期事务拥有，协议兼容性先于 GUI 启动。** 启动只发布一个受管 runtime 候选；restart 与 deactivate 经同一所有者串行化，在等待 disposer 前先解除候选所有权，而同步设置的 deactivate 标记会阻止已排队或迟到的工作在其后发布。扩展会保留服务器就绪状态，直到页面监听器安装完成，防止把正常启动间隔误判为不兼容。收到该信号后，webview bootstrap 只为 `host.describe` 暂时使用 bridge，要求 host 的 `protocolVersion` 匹配内置客户端，并仅在成功后把 bridge 公布给 `AppWebEntry`。版本更旧、更新、缺失或格式错误时会渲染不兼容 host 状态，客户端图及其 stream 均不启动；编辑器原生层采用同一版本要求。

**该 shell 住在 app 里，而非 `packages/client`。** VS Code 侧栏是它唯一的消费者，而紧邻的主题适配器已经确立了"webview 自有模块"的先例。出现第二个窄容器宿主时才值得把它提升为包。

**让占用者放得下用了两种机制，按每个组件"以什么为参照测量自己"来选。** 由容器决定尺寸的部分采用 `-host` 变量：组件把桌面值留作默认（`var(--dsh-…-host, 32px)`），框架统一覆盖一次，宽屏 shell 分毫不动，而这层间接在读取它的那一行就看得见。这覆盖了 composer 的留白、卡片上限、dock 内缩、工具行间距与模型名上限，以及 hero 的留白和它的 glow——一个刻意比自身卡片更宽的素材，窄宿主宁可丢掉它也不为它付一条滚动条。composer 工具行另外获得换行许可，因为它的控件是固定尺寸的：过了某个宽度，唯一装得下它们的就是第二行。以视口为锚的部分则用媒体查询：设置模态（188px 导航轨变横向条，外观三卡从三行变一行）以及设置行 48px 的文字内缩——单是后者就把一行标题挤成了三行。webview 本身是一个 iframe，因此 `100vw` 与媒体查询看到的就是侧栏；浏览器壳只在窗口真的这么窄时才触发同样的规则，而那本就是想要的行为。

**`ThemePresenter` 从 `ui-layout` 移入 `ui-theme`。** 可替换的 shell 不该掌管调色板抵达文档的路径；presenter 现在与投影其快照的服务同处一包，`ui-layout` 也不再 inject `theme`。

## 考虑过的替代方案

- **为窄视口重写呈现层**——即该请求"被背书但昂贵"的读法。作为*第一步*被否决：实测表明只有 shell、设置模态与 trajectory 表在几何上不可能，而消息列与卡片用的是 `max-width` 上限、会自然收缩。替换 shell 现在就换来可用的侧栏，把逐组件的收紧留作后续工作，且每次改动都有实测依据。
- **让宽屏 shell 响应式**——一套组件横跨 320px 到 1920px，意味着每个布局决策里都有一个 breakpoint 分叉，而三栏几何没有有意义的窄形态。两个 shell 共用一份槽契约，能让各自都诚实。
- **为窄栏 shell 起新槽名**——语义上更干净（侧栏没有"侧"列），但那会在任何东西渲染之前就强制每个 registrant 出窄栏变体。复用槽名正是这次替换免费的原因。
- **保留编辑器 tab 面板作为第二界面**——推迟而非拒绝：侧栏是所要求的形态，且单一界面更容易保持诚实。日后若想要宽屏形态，该 shell 可复用。
- **在 webview 内做标签栏**——在最窄处消耗纵向像素，且重复 VS Code 已经绘制的 chrome。

## 后果

侧栏在实测 259px 宽度下渲染出真实 GUI，三个窗格挂载、一个激活，title actions 在其间路由；已在真实编辑器的扩展开发宿主中验证。确定性测试覆盖并发 restart/deactivate、服务器就绪协议门禁、不兼容 bridge 协议、ready/replay 路由、shell 契约以及单 shell roster 替换。

施加紧凑尺度后，259px 的侧栏在 hero、会话窗格与设置模态上报告零个横向溢出元素、零个横向滚动容器，其中包括携带完整控件集（附件、权限、模型、发送）的 composer。设置模态从内容列仅剩约 23px——视口钳制后的面板里塞着 188px 导航轨——变成占满整个界面。另有两处会溢出自身容器的钳制被当作纯逻辑修掉，而非样式问题：slash 菜单的 260px 下限与 trajectory 详情面板的 320px 下限，现在会在容器比下限本身更窄时让步。

组装后的浏览器快照通过生产 CSP，以 259px 宽度针对无密钥 fixture（测试前置数据）启动构建出的 webview，并通过 Web 通道共享的稳定 ARIA／golden helper 记录会话页、问答与审批 composer，以及代表性的 Bash 和 Web Search 行。shell 没有根级横向滚动或未收束的溢出；一个 Markdown 表格保留了一处有意的内容级横向滚动容器。浏览器启动失败会先关闭测试服务器再向上传播。另有 fixture 支撑的 Extension Host 通道验证激活和原生集成；编辑器中的真实提供方轮次仍需手工核验。

bundle 重量未变：它由完整插件 roster 与 `ui-primitives` 的 Markdown/KaTeX/shiki 栈主导，而后者是 web shell seed 里的平台单例。给它瘦身与布局是两个问题，本次改动刻意不碰。
