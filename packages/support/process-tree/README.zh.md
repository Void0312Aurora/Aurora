# dsh-process-tree

[English](README.md) | 中文

零依赖的进程树终止原语，由桌面外壳（`@deepseek-ai/dsh-desktop`）共用：其主进程与孤儿 reaper 原先各自携带一份 kill 逻辑副本，现在都改调本原语。子进程后端的 tree-kill seam 是规划中的后续消费者。

## 接口面

```ts
import { killProcessTree } from '@deepseek-ai/dsh-process-tree'

// Terminate pid and its whole tree: taskkill /T /F on Windows; on POSIX the
// group gets SIGTERM and SIGKILL five seconds later if it ignored the signal.
killProcessTree(serverPid)
```

一次调用、永不抛错；ESRCH 静默（树已不在——这正是期望结果），其余失败经可注入的 `logger` 上报（默认 `console.error`）。Windows 用 `taskkill /T /F`，因为 `child.kill()` 只对直接子进程做 `TerminateProcess`。POSIX 要求树根以 detached 方式拉起、自成进程组：负 pid 一次信号覆盖整个组——先 SIGTERM，`graceMs`（默认 5000）后仍未退出则补发 SIGKILL。升级定时器是普通 `setTimeout`，因此 detached 的短命调用方（桌面 reaper）会存活到强制 kill 落地。

## Model Experience

无——这是纯进程原语，不涉及任何模型请求。

#### KV Cache 影响

无——不进入请求前缀。

## Known Limitations and Deferred Work

- **升级不可撤销**——`killProcessTree` 安排完定时器即返回；SIGKILL 无法取消，定时器句柄也不对外。桌面调用方（退出路径、reaper）从未需要该句柄。
- **Windows 无宽限阶段**——taskkill `/T /F` 立即终止；Windows 的优雅关闭通道随桌面外壳自身的 v1 决策一并推迟。
- **不校验 pid 归属**——原语只对 pid 所指的树发信号；调用方自行负责 pid 属于自己（桌面只会杀自己拉起的子进程）。
- **subprocess-local 仍自带 kill seam**——`packages/subprocess/subprocess-local/src/spawn.ts` 中的 `killGroup`/`taskkillProcessTree`/`signalTree` 早于本包；迁移是独立步骤，因为该包的拆除竞态与幂等契约不同于桌面的升级流程。
