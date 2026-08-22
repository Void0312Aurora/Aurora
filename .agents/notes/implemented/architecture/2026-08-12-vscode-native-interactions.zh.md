# Agent Note：dsh-vscode 原生交互

Status: implemented

[English](2026-08-12-vscode-native-interactions.md) | 中文

> Scope：在[面板/服务器/桥基础](2026-08-12-vscode-rich-ui-extension.md)之上，`apps/vscode` 的编辑器原生交互层——一个宿主侧 mux 流消费者，通过可取消的 VS Code 控件应答 agent 的审批与问答请求。

## 问题

webview GUI 已在面板内渲染审批与问答，但编辑器用户往往没在看面板。一个阻塞 agent 的审批应能从原生控件应答，问答应能从 QuickPick 或输入框应答，而不必去找面板标签页。`approval/requested` 帧只报工具名，因此原生界面还需要找到匹配的调用呈现，且不能混淆不同会话中相同的调用 id。

## 决策

**扩展宿主驱动自己的 wire 客户端，而非第二个 webview。** `LoopbackApiClient`（`apps/vscode/src/host-client.ts`）是薄的 `AbstractApiClient` 子类，`resolveBase()` 返回受管服务器当前 origin，`doFetch` 是全局 fetch。因为扩展宿主不是浏览器，回环 Host 无需改动栅栏即可通过 `/api` 浏览器信任栅栏——与桥存在的原因相同，只是直接应用。这免费复用了全部协议不变量（rpcId、信封、zod、SSE 解码、`respond`）。

**`NativeInteractions`（`apps/vscode/src/interactions.ts`）消费 mux 流并经注入的 UI 应答。** 它按会话与调用 id 缓存 `tool/call` 帧，并且只在工具名也与审批一致时使用缓存 view。应答走请求的**信封** rpcId（而非载荷字段）：审批与问答都回显流信封的 rpcId，后续 `*/resolved` 帧则按审批 id 或请求 rpcId 对应。每个打开的控件由一个 `AbortController` 所有；请求被解决或流代次断开时，控件会关闭且不发送迟到应答，替换代次只为重放的未决请求创建一个控件。`apps/vscode/src/native-ui.ts` 把审批实现为 QuickPick，把问答实现为 QuickPick 或输入框，并在接受、隐藏或 abort 时销毁 VS Code 控件与监听器。

## 考虑过的替代方案

- **只经 webview 应答**——面板没开时，阻塞在审批上的 agent 无法应答，除非用户找到面板；原生提示正是编辑器集成的意义。
- **给扩展宿主再来一个完整 webview 客户端**——宿主是 Node，只需要 wire 客户端，不需要 React 或 slot 系统。`LoopbackApiClient` 在共享基类上只多约 20 行。
- **原生提示在时抑制 webview 提示**——需要 wire 不提供的跨界面协调，且面板可能根本没开；多客户端先应答者胜本就正确，故 v1 让两者都显示并记录之。

## 后果

`NativeInteractions` 随面板自动运行；审批与问答成为面板内提示旁的原生提示。`interactions.spec.ts` 覆盖会话限定的缓存增强、工具名核对、信封 rpcId 应答、别处解决即关闭、dismissed 不发送与重连重放。`native-ui.spec.ts` 以假的 VS Code 控件演练取消。组装后的 `@vscode/test-electron` 通道加载构建后的扩展入口，在重启受管服务器前应答一次真实原生审批。
