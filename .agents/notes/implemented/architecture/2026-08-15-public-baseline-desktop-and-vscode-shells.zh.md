# Agent Note: 公共基线上的桌面端与 VS Code 外壳

Status: implemented

[English](2026-08-15-public-baseline-desktop-and-vscode-shells.md) | 中文

## 问题

Electron 桌面端与 VS Code 产品需要和公开 `dsh` CLI 使用相同的运行时约定、包图与发布基线。如果它们继续依赖私有快照，包重命名、Cordis scope 变更、Web 客户端组合和部署闭包会分别发生漂移。VS Code webview 也无法直接调用受管的环回服务器，因为它的 origin 不是服务器 origin；同时，编辑器上下文需要在不唤醒模型的前提下进入会话。

## 决策

`apps/desktop` 与 `apps/vscode` 作为私有产品组合保存在公共基线 monorepo 中。两者都启动仓库内的 `dsh web` 命令，并携带仅包含依赖的闭包；闭包的工作区依赖与当前 CLI、Web 和 SDK 运行时图一致。工作区显式包含两个闭包根目录，产品构建会在部署前生成 Web 前端，因此打包后的闭包包含 `@deepseek-ai/dsh-web-frontend/dist`。

两个产品下方共享进程职责。`@deepseek-ai/dsh-web-launcher` 负责解析并 spawn `dsh web`、处理 Windows 命令 shim、解析就绪行、轮询 HTTP 就绪状态以及取消启动。`@deepseek-ai/dsh-process-tree` 负责终止整个进程树。Electron 与 VS Code 宿主消费这些包，不再各自维护子进程实现。

VS Code webview 静态打包其客户端插件 roster，并通过 `AppWebEntry` 的 `staticPlugins` 选项传入。当 bootstrap 安装 `globalThis.__DSH_WEBVIEW_BRIDGE__` 后，连接客户端选择 `PostMessageApiClient`；扩展宿主会先把每个中继请求限制在受管服务器的精确 origin 和 `/api/` 路径前缀内，再执行 fetch。桥不存在时，普通浏览器与 fixture 传输保持不变。

独立打包的扩展通过 `API_PROTOCOL_VERSION` 校验 `host.describe.protocolVersion`。协议版本 `1` 覆盖桥所消费的 API 与帧结构。Webview bridge 只有在探测成功后才暴露托管服务地址，客户端连接也只有在同一检查完成后才打开事件流，因此缺失或不兼容的版本不会到达帧消费者。破坏性协议变更会递增该常量；应用包版本不作为兼容性信号。

编辑器上下文使用 `session.injectContext`。宿主校验非空 `ContentBlock[]`，解析普通会话的 Agent，并以固定的 `ide` plugin 来源及原始请求 `rpcId` 调用 `Agent.inject()`。该操作会追加持久化、面向模型的上下文，但不会开始轮次或分派斜杠命令。由会话支撑的 subagent 继续执行既有的所有权拒绝规则。

## 考虑过的替代方案

**把这些外壳继续保存在独立的下游仓库中。** 这种方式保留仓库隔离，但每次包重命名和运行时约定迁移都要重复实施，而且无法通过工作区检查证明打包产品与公开 CLI 图一致。

**让 webview 直接调用环回服务器。** webview origin 无法通过浏览器信任边界；放宽该边界会扩大服务器攻击面。受限的扩展宿主中继可以保留该边界，又不会授予任意环回 fetch 能力。

**使用包版本执行协议兼容性检查。** 产品版本会因协议结构以外的原因变化，无法精确标识破坏性 API 变更。独立的整数协议版本使兼容性判断保持显式。

**把编辑器上下文作为普通提示词发送。** 普通提示词可能唤醒模型、进入排队或 steering 语义，并分派命令。`Agent.inject()` 保留所需的无轮次行为与持久化来源信息。

## 后果

产品外壳与公共源码基线同步演进，并共享 launcher、进程树、API 与客户端启动约定。它们的包与闭包元数据使用根发布线和 MIT 许可证。代价是工作区图扩大，并且只要独立发布的客户端会观察到破坏性协议变更，就必须显式递增协议版本。

宿主与客户端 TypeScript 项目构建覆盖共享约定；聚焦测试覆盖协议拒绝、`session.injectContext` 路由与 rpcId 来源、格式错误的 bridge 流量、重复 id、流式响应重建，以及响应头前后的取消；CI 产物门禁会在根构建和产品构建后运行 built-entry 测试及生产 CSP 下的 Webview 验收；闭包部署检查证明每个打包运行时都包含已构建的 Web 前端。
