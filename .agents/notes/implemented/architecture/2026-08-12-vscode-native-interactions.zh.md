# Agent Note：dsh-vscode 原生交互与编辑器目标解析

Status: implemented

[English](2026-08-12-vscode-native-interactions.md) | 中文

> Scope：在[面板/服务器/桥基础](2026-08-12-vscode-rich-ui-extension.md)之上，`apps/vscode` 的编辑器原生层——一个宿主侧 mux 流消费者，通过 VS Code 提示应答 agent 的审批与问答请求；以及一个纯解析器，把工具 view 的模型面路径转成绝对编辑器目标与整文件 diff 面板。

## 问题

webview GUI 已在面板内渲染审批、问答与工具 diff。但编辑器用户往往没在看面板：一个阻塞 agent 的审批应能从原生通知应答，问答从 QuickPick 应答，而不必去找面板标签页。另外，IDE 的富价值在于把 agent 的编辑用真正的 diff 编辑器打开、跳到它触碰的行——而 wire 两者都不直接给：`approval/requested` 帧只报工具名，结果侧 diff 是 3 行上下文的 hunk 片段而非整文件，且每个路径都是模型面（相对会话 cwd）而非编辑器 URI。

## 决策

**扩展宿主驱动自己的 wire 客户端，而非第二个 webview。** `LoopbackApiClient`（`apps/vscode/src/host-client.ts`）是薄的 `AbstractApiClient` 子类，`resolveBase()` 返回受管服务器当前 origin，`doFetch` 是全局 fetch。因为扩展宿主不是浏览器，回环 Host 无需改动栅栏即可通过 `/api` 浏览器信任栅栏——与桥存在的原因相同，只是直接应用。这免费复用了全部协议不变量（rpcId、信封、zod、SSE 解码、`respond`）。

**`NativeInteractions`（`apps/vscode/src/interactions.ts`）消费 mux 流并经注入的 UI 应答。** 它缓存 `tool/call` 帧（名字加随帧而来的 call view），使审批提示能展示这次调用要做什么——审批帧本身只带 `toolName`/`callId`。应答走请求的**信封** rpcId（而非载荷字段）：审批与问答都回显流信封的 rpcId，而随后的 `*/resolved` 帧按 approvalId（审批）或同一请求 rpcId（问答）对应，这也是 pending map 键与 respond id 分开跟踪的原因。请求在别处解决时仍开着的提示经其 abort 信号关闭——与 webview 的多客户端并存，先应答者胜，败者得无害的 `not-pending` 回执。重连仅重开流；host 在打开时重放仍未决的审批/问答帧，因此本界面无需 history 对账（那是 webview 的 ConnectionController 的活）。

**路径与 diff 计算是纯模块。** `apps/vscode/src/locations.ts` 把模型面路径按会话 cwd 解析（`editorTargets`），并重构整文件 diff 面板（`diffMaterials`）：编辑场景左侧是当前磁盘文本（不可读时回退到 hunk 的 `oldText`），create/overwrite 左侧为空，右侧是模型的结果文本。保持其纯净让 vscode 耦合的 `vscode.diff`/`showTextDocument` 胶水很薄，也让解析可无密钥测试。

## 考虑过的替代方案

- **只经 webview 应答**——面板没开时，阻塞在审批上的 agent 无法应答，除非用户找到面板；原生提示正是编辑器集成的意义。
- **给扩展宿主再来一个完整 webview 客户端**——宿主是 Node，只需要 wire 客户端，不需要 React 或 slot 系统。`LoopbackApiClient` 在共享基类上只多约 20 行。
- **原生提示在时抑制 webview 提示**——需要 wire 不提供的跨界面协调，且面板可能根本没开；多客户端先应答者胜本就正确，故 v1 让两者都显示并记录之。
- **整文件 diff 走 wire**——会让每个工具结果背上模型永不需要的整文件正文；按需从磁盘重构让 wire 保持精简，也正是编辑器能做而远程 GUI 做不到的。

## 后果

`NativeInteractions` 随面板自动运行；审批与问答成为面板内提示旁的原生提示。其帧处理——缓存增强、信封-rpcId 应答、别处解决即关闭、dismissed 不发送、重连重放——经假客户端与假 UI 无密钥覆盖（`apps/vscode/tests/interactions.spec.ts`）；路径/diff 解析器经注入的磁盘读取覆盖（`apps/vscode/tests/locations.spec.ts`）。刻意推迟的：打开原生 diff 编辑器或跳转到某位置有其解析器基础但尚无触发，因为触发是来自工具卡的客户端"在编辑器中打开"信号——一处属于专门 UI 阶段的客户端插件改动。IDE 上下文注入（`session.injectContext`，已在 wire 上）是下一阶段的采样工作。vscode 耦合的胶水（`extension.ts` 里的通知/QuickPick 适配器）按面板 HTML 解析器同一规则不做测试——纯逻辑测试，`vscode` 模块边界不测。
