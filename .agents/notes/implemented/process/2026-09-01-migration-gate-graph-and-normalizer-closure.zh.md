# Agent Note: closing the baseline-migration gate graph and snapshot normalizer

Status: implemented

[English](2026-09-01-migration-gate-graph-and-normalizer-closure.md) | 中文

## 问题

采用公开 DSH 基线把 Aurora 的产品外壳迁到了新的包图上，此后有四项必需检查失败，原因都由这次迁移本身引入。

merge-forward 保留了 `apps/desktop` 对 `requireWebLaunchPipes` 的调用，同时采用了更新的 launcher；后者已删除该函数，改用 `WebLaunchChild` 返回类型，其 `stdout` 与 `stderr` 声明为非空。desktop 的 `tsc` 因找不到该名称而失败，导致 `product-artifacts` 门控失败，于是没有任何环节构建 `apps/vscode/dist/`；VS Code 侧边栏快照、生产 CSP 下的 webview 启动、以及 built-entry smoke 随之因缺少产物包而失败。同一处被删除的类型收窄还使 `main.ts` 中的 `stdout` 与 `stderr` 被推断为 `error` 类型，产生九个 lint 错误中的七个。

把 `apps/web/tests/scaffold.ts` 的 ARIA 归一化器折叠进共享的 `apps/test-support/snapshot.ts` 时丢失了两条规则。时长模式丢掉了 `\d+m ?\d+s` 中的可选空格，因此统计行的紧凑写法 `3860m53s` 不再折叠，而消息装饰模板的 `2m 42s` 写法仍然折叠；compaction token 规则则完全消失，尽管已提交的 golden 仍然期望 `{{tokens}}`。五个 web e2e golden 因此在它们本就为排除而编写的波动上失败。

另有两项失败早于外壳迁移。`ciWindowsObservationalGates` 携带了 VS Code built-entry smoke，但同一聚合中没有 `product-artifacts` 门控，因此必需的 Windows 作业断言的是该 lane 中无人生产的产物包。而 headless keep-alive 测试给适配器的空闲预算是 150 ms，对应 60 ms 的 SSE 注释：90 ms 的余量会被共享 runner 超出，使看门狗到期，而默认重试策略会重放该请求——表现为测试期望一次请求却观察到两次。

## 决策

`apps/desktop` 直接从 `spawnWebLaunch` 返回的 child 上解构 `stdout` 与 `stderr`。固定的 stdio 元组是类型层面的保证，因此运行时再做检查属于在同进程类型化边界上做校验。

共享归一化器恢复这两条丢失的规则，并附上说明各自存在理由的注释。一个归一化器同时服务 Web 与 VS Code 两条 lane，因此其中缺失的规则，在该 lane 拥有的每个 golden 上都缺失。

`builtTreeConsumerGates` 拥有那些读取 `build` 门控输出树的门控，每个拥有普通 `build` 的聚合都追加它。这既消除了 `jscpd` 报告的克隆，也使 Windows 的漏洞不可表达：任何聚合都无法在缺少生产其产物包的 artifact 门控的情况下携带 built-entry smoke。一个覆盖全图的测试跨所有模式断言该关系，而非依赖固定列表，因此新增模式自动继承该检查。

keep-alive fixture 的空闲预算由它公布的间隔推导：注释每 250 ms 一次，预算 500 ms。预算仍必须大于一个间隔且小于三个间隔，因此一个丢掉注释处理的构建仍会空闲超时、仍会重试——测试拥有的契约未变，增长的只是相对 runner 调度的余量。fixture 从测试设置的环境中读取该预算，使这两个数字只有一处归属。

`PostMessageApiClient` 通过函数读取其 `terminal` 与 `cleanupRequested` 标志。两者都由监听器闭包改写，而同步的宿主可以在 `onMessage` 仍在安装时驱动该闭包；静态收窄不建模这次调用，因而把直接读取报告为恒假。这正是 `waitForHttpOk` 已经用于其 abort 标志的模式。

## 考虑过的替代方案

**恢复 `requireWebLaunchPipes`。** 这样能通过编译，但 launcher 是有意用一个不具备两个管道就无法构造的类型，替换掉运行时管道检查。重新引入它等于重新加上静态接口已经保证的校验。

**重新录制失败的 web golden。** golden 是正确的，回归的是归一化器。重录会把某台机器测得的时长和某个工作副本的路径长度烘进已提交的期望值，而下一次在另一台主机上的运行会再次失败。

**把 headless keep-alive 测试标记为 flaky，或删掉它的重试断言。** 请求次数正是该测试观察注释重置看门狗的方式。删除它就删除了契约；隔离它则掩盖了一个真实的提供方传输行为。同时放宽两侧保留了断言，只移除对 runner 的敏感性。

**给 Windows 聚合单独加一个 `product-artifacts` 条目。** 这修好了这条 lane，却让下一个聚合仍可犯同样的错误。把生产者与消费者绑定在一个 helper 中，并用覆盖每个模式的测试守住，修的是这一类问题。

**用内联注释抑制那两个恒假 lint 错误。** disable 注释等于断言规则错了。就其可见范围而言规则是对的；函数读取告诉编译器闭包实际做了什么，也与仓库既有实践一致。

## 影响

desktop 与 VS Code 可从干净的树构建，因此 artifact 门控产出 `apps/vscode/dist/`，其三个依赖套件针对真实产物包运行，而不是因缺失而失败。lint 无错误，`jscpd` 无克隆，`webview-bridge.ts` 与 `web-launcher/src/index.ts` 达到单文件 100%。

新增测试覆盖解析边界，以及恶意或可重入宿主能到达的路径：在有和没有可关联 id 两种情形下的每一种畸形请求与畸形响应拒绝、协议版本匹配与不匹配、一条畸形消息使其所属调用失败而无法关联或属于他者 id 的消息被忽略、以及单次尝试耗尽整个截止期限的就绪轮询。仍余一行不可达——`cleanup` 的幂等保护，其每个调用方在 terminal 时都已提前返回——并注释说明为何没有路径会二次到达。

keep-alive fixture 中的 `streamIdleTimeoutMs` 现在由启动它的测试提供。在测试之外运行该 fixture 会观察到适配器的正有限值校验在加载时失败，而不是一个静默的默认值，这正是缺失引用应有的响亮失败。

门控图测试遍历每个模式，因此新增一个携带 built-entry smoke 却没有 artifact 门控的模式，会在该测试处失败，而不是在必需的 Windows 作业中失败。
