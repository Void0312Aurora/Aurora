# Agent Note：dsh-vscode IDE 上下文注入

Status: implemented

[English](2026-08-12-vscode-ide-context-injection.md) | 中文

> Scope：`apps/vscode` 的编辑器上下文 feed——一个防抖采样器，读取活动编辑器（文件、选区或游标窗口、诊断），抑制 no-op 更新，并经 `session.injectContext` 把有界读数注入活动会话。建立在 [wire 方法](2026-08-12-wire-protocol-version-and-ide-context-injection.md)与[原生交互客户端](2026-08-12-vscode-native-interactions.md)之上。

## 问题

编辑器用户期望说"修一下这个文件"或"为什么这里失败"，让 agent 知道"这个"是什么，而不必粘贴。模型只知道会话日志所载，因此扩展必须把编辑器状态喂进会话。三个约束塑造它：feed 不能唤醒模型（编辑器移动是上下文，不是 prompt），不能在每次击键或空闲游标抖动时灌一条读数，且必须命中用户真正在聊的会话——那归 webview 所有，而非扩展宿主。

## 决策

**采样与变化抑制是纯模块；feed 及其 VS Code 接线很薄。** `apps/vscode/src/ide-context.ts` 把普通的 `EditorState`（扩展从 VS Code API 构建）转成有界的 `IdeContextSnapshot`：一段模型面读数加一个作变化检测键的 `signature`（签名就是渲染文本本身，所以经过全部边界后渲染相同的两次采样即是 no-op）。边界在每一层生效——选区/窗口字符数、诊断条数、单条诊断消息上限，以及完整渲染读数的最终上限。`apps/vscode/src/context-feed.ts` 对编辑器 nudge 防抖、采样、抑制每会话未变化的签名，并通过单一队列串行调用 `session.injectContext`，使完成不会乱序。其 `beforeFirstPrompt(sessionId)` 路径提供逐 session 的 single-flight 注入尝试。`ApiBridge` 是顺序拦截点：转发合法 `session.prompt` 前，它会等待该显式 session 的注入；活动会话通知与 prompt 的竞态因此共享同一个 Promise。被拒绝或失败的注入会记录日志并放行 prompt，但不记录签名，因此后续编辑器 nudge 仍可重试。把纯核心留在 `vscode` 模块之外，让边界、防抖、显式 session 顺序、串行化、抑制、每会话签名记忆与拒绝重试都能无密钥测试。

**目标会话在宿主侧从事件流跟踪。** `apps/vscode/src/active-session.ts` 跟随 host 流，记住最近运行的会话（最强的"用户在此"信号），回退到它见到的第一个会话，使全新的单会话窗口在任何 turn 运行前就有目标。活动会话变化触发 `onActiveChanged`，扩展将其接到"忘掉前一会话的签名并 nudge feed"——当前编辑器上下文对新活动会话是新的，因此无需等下一次编辑器移动就得到一份读数。这是启发式：webview 拥有真正的会话选择，在 webview→host 活动会话信号出现前，"最近运行"对常见的单会话流正确，多会话附着时则为近似。

## 考虑过的替代方案

- **把编辑器上下文嵌进每条 prompt（dsh-vscode 聊天参与者做法）**——对每轮聊天参与者正确，此处错误：常驻面板两次 prompt 之间的编辑器变化在用户发消息前不可见，且上下文会在日志中读作用户话语而非环境上下文。no-wakeup 注入正是对的原语。
- **定时注入**——固定节奏要么滞后真实编辑，要么灌满空闲；带签名抑制的防抖编辑器事件才跟踪真实变化。
- **注入所有附着会话**——嘈杂且错误；给用户所在聊天的读数不该出现在无关会话里。宿主侧活动会话启发式把它限定到一个。
- **等 webview 活动会话信号再发布任何注入**——那信号是客户端插件改动；宿主侧启发式现在就交付可用的单会话 v1，日后细化而无需重做 feed。

## 后果

编辑器移动为活动会话喂入 prompt 可指代的有界上下文，既不唤醒模型也不灌满它。整个原生层只在扩展宿主用自身版本核验服务器 `protocolVersion` 后启动。采样器（`ide-context.spec.ts`）、串行 feed（`context-feed.spec.ts`）、活动会话跟踪器（`active-session.spec.ts`）与桥屏障（`bridge.spec.ts`）经注入的状态、客户端、调度器与延迟转发无密钥覆盖。组装后的 `@vscode/test-electron` 通道在激活构建后的扩展前打开文件，通过构建后的 webview 和只替换 LLM 为重放的生产 `dsh web` 组合发送 prompt，再读取生产 JSONL，要求 IDE 上下文早于用户 prompt 与首个 request header。已知近似只剩多会话附着时的后台编辑器 nudge；首个桥接 prompt 使用其显式 session。有界值（`maxTextChars`、`maxDiagnostics`、单条诊断与总量上限、游标窗口）在 v1 是固定常量；待扩展有设置面后成为设置项。
