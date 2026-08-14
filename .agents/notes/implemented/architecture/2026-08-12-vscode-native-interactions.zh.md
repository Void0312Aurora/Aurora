# Agent Note：dsh-vscode 原生交互与编辑器目标解析

Status: implemented

[English](2026-08-12-vscode-native-interactions.md) | 中文

> Scope：在[面板/服务器/桥基础](2026-08-12-vscode-rich-ui-extension.md)之上，`apps/vscode` 的编辑器原生层——一个宿主侧 mux 流消费者，通过 VS Code 提示应答 agent 的审批与问答请求；以及一个纯解析器，把工具 view 的模型面路径转成绝对编辑器目标与一致的双栏 diff 材料。

## 问题

webview GUI 已在面板内渲染审批、问答与工具 diff。但编辑器用户往往没在看面板：一个阻塞 agent 的审批应能从原生通知应答，问答从 QuickPick 应答，而不必去找面板标签页。另外，IDE 的富价值在于把 agent 的编辑用真正的 diff 编辑器打开、跳到它触碰的行——而 wire 两者都不直接给：`approval/requested` 帧只报工具名，结果侧 diff 是 3 行上下文的 hunk 片段而非整文件，且每个路径都是模型面（相对会话 cwd）而非编辑器 URI。

## 决策

**扩展宿主驱动自己的 wire 客户端，而非第二个 webview。** `LoopbackApiClient`（`apps/vscode/src/host-client.ts`）是薄的 `AbstractApiClient` 子类，`resolveBase()` 返回受管服务器当前 origin，`doFetch` 是全局 fetch。因为扩展宿主不是浏览器，回环 Host 无需改动栅栏即可通过 `/api` 浏览器信任栅栏——与桥存在的原因相同，只是直接应用。这免费复用了全部协议不变量（rpcId、信封、zod、SSE 解码、`respond`）。

**`NativeInteractions`（`apps/vscode/src/interactions.ts`）消费 mux 流并经注入的 UI 应答。** 它按会话与调用 id 缓存 `tool/call` 帧，只在工具名也与审批一致时使用缓存 view，并在 `turn/end` 清除该会话条目。应答走请求的**信封** rpcId（而非载荷字段）：审批与问答都回显流信封的 rpcId，后续 `*/resolved` 帧则按审批 id 或请求 rpcId 对应。每个打开的控件由一个 `AbortController` 所有；请求被解决或流代次断开时，控件会关闭且不发送迟到应答，替换代次只为重放的未决请求创建一个控件。`apps/vscode/src/native-ui.ts` 把审批实现为 QuickPick。问答使用带标签的普通选项/Other/Skip；Other 打开有校验的输入框，多选会在自定义文本旁保留普通选项，任何合成标签都不会进入 Host 答案。与 webview 并存时仍是先应答者胜，控件与监听器会在接受、隐藏、abort 或代次变化时销毁。

## 考虑过的替代方案

- **只经 webview 应答**——面板没开时，阻塞在审批上的 agent 无法应答，除非用户找到面板；原生提示正是编辑器集成的意义。
- **给扩展宿主再来一个完整 webview 客户端**——宿主是 Node，只需要 wire 客户端，不需要 React 或 slot 系统。`LoopbackApiClient` 在共享基类上只多约 20 行。
- **原生提示在时抑制 webview 提示**——需要 wire 不提供的跨界面协调，且面板可能根本没开；多客户端先应答者胜本就正确，故 v1 让两者都显示并记录之。
- **整文件 diff 走 wire**——会让每个工具结果背上模型永不需要的整文件正文；在用户打开原生 diff 的那一刻把 hunk 应用到磁盘文件，让 wire 保持精简，也正是编辑器能做而远程 GUI 做不到的（该应用步骤随编辑器 diff 触发一并落地）。

## 后果

`NativeInteractions` 在[协议门禁](2026-08-12-wire-protocol-version-and-ide-context-injection.md)通过后随面板自动运行；审批与问答成为面板内提示旁的原生提示。`interactions.spec.ts` 覆盖按会话隔离的缓存增强与 turn 结束清除、工具名核对、信封 rpcId 应答、别处解决即关闭、dismissed 不发送、一代流结束重置与重连重放。`native-ui.spec.ts` 以假的 VS Code 控件演练取消，以及仅选项、仅自定义、选项加自定义、显式跳过和空白重试等答案形状。组装后的 `@vscode/test-electron` 通道负责生产 CLI/webview 往返；原生控件协议一致性留在确定性的宿主侧套件中。IDE 上下文注入在[上下文注入阶段](2026-08-12-vscode-ide-context-injection.md)骑乘同一宿主客户端。
