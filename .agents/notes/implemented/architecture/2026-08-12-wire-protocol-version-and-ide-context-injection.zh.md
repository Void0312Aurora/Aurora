# Agent Note：wire 协议版本与 IDE 上下文注入

Status: implemented

[English](2026-08-12-wire-protocol-version-and-ide-context-injection.md) | 中文

> Scope：`/api` wire 契约（`packages/host/apiproxy`）为独立发布的 VS Code 扩展新增的两项：`host.describe` 的 `protocolVersion` 字段，以及 `session.injectContext` 一元方法与其 `ide-context` 消息来源成员。

## 问题

`/api` 契约原本面向与 host 一同发布的客户端（浏览器 GUI、桌面外壳），因此 `host.ts` 刻意不带协议版本——其头注释预留了"只在独立发布的客户端出现时"引入。VS Code 富 UI 扩展正是那个客户端：它从 marketplace 安装、会遇到任意版本的 host，必须在 wire 不兼容时响亮失败，而不是消费自己误解析的帧。扩展还需要在两次 prompt *之间*，把编辑器状态（活动文件、选区、诊断）喂给长驻会话的模型。`session.prompt` 承载不了它：两种 mode（`queue`/`steer`）都会唤醒模型，且其 `user` 来源会把内容呈现为用户话语。host 已经拥有正确的原语——`Agent.inject()`，即 next-step/no-wakeup 预设，追加一条持久的带来源 `user/message`——只是 wire 上没有开口。

## 决策

**`host.describe` 现在返回 `protocolVersion`（`api/host.ts` 中的 `API_PROTOCOL_VERSION` 常量，从 1 起）。** 独立发布的客户端在连接握手时据此把门；仓库内客户端与 host 一同发布，忽略它。任何对方法、载荷或帧形状的破坏性变更都在同一 PR 中递增该常量。

**`session.injectContext` 是 `Agent.inject()` 的 wire 面。** 载荷为 `{ sessionId, content: ContentBlock[] }`（非空；没有 mode 字段——注入只有一种行为）。网关经与 `session.prompt` 相同的 `agentFor` 路径解析 agent（含 subagent 防护与冷恢复），调用 `agent.inject(createUserMessage({ content, source }))`。绝不派发斜杠命令——注入是上下文，不是输入。错误映射与 prompt 一致：inject 的同步抛错映射为稳定的 `agent-busy` 码。

**来源标识是 `MessageSourceMap` 新增的 `ide-context` 成员**（在 `api/sessions.ts` 声明合并，与 `user-rpc` 同一模式）：`{ kind: 'plugin'; plugin: 'ide'; rpcId }`。`kind` 保持 `plugin`，因为对模型而言这与任何 host 上下文插件的环境上下文无异——模型面不携带传输词汇；固定的 `'ide'` 标签在持久日志中区分 wire 注入与 host 插件注入；请求的 rpcId 是审计/对账字段。

## 考虑过的替代方案

- **上下文嵌入 prompt（dsh-vscode 聊天参与者的做法）**——把编辑器状态格式化进每条用户 prompt。对每轮新 prompt 的聊天参与者是正确的，对常驻 webview 客户端是错误的：两次 prompt 之间的编辑器变化在用户恰好发消息前都不可见，且上下文会在持久日志中伪装成用户话语。
- **host 侧 `ide-context` 插件 + 旁路信道喂数据**——wire 不动，但扩展在另一个进程里，旁路信道本身就是一条新 wire；这条 RPC 就是那个信道，只是省去了一套自造协议。
- **用 semver 字符串而非整数 protocolVersion**——契约的兼容性单位是"这个客户端到底能不能消费这条 wire"；一个整数恰好回答这个问题，变更记录归 api-contracts 文字所有。

## 后果

handler 的编译器锁定表（`rpc-map.ts`、`UNARY_ROUTES`、`UNARY_VALUE_SCHEMAS`）迫使每个载体面都确认新方法——fixture 客户端（`packages/client/connection/src/client/fixture.ts`）将其实现为空闲态 no-wakeup 追加，因此无密钥 web 通道也演练帧字段。网关路由、来源标识与错误映射由 `packages/host/apiproxy/tests/api-proxy-inject.spec.ts` 覆盖；wire 往返由 `fetch-carrier.spec.ts` 覆盖；schema 接受/拒绝由 `rpc-schemas.spec.ts` 覆盖。注入本身的 no-wakeup/暂存语义仍归 agent-loop 套件所有。无密钥已交付装配 smoke 会通过 Loader 与 HTTP 载体启动正式 base 和 Web overlay，固定 `host.describe.protocolVersion`，证明注入会写入持久的 `ide-context` 来源且不发起模型请求，并在真实 LLM adapter 调用点观察到该上下文位于后续提示词之前。VS Code 通道另行证明编辑器生产端与扩展载体。
