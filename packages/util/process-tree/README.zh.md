# dsh-process-tree

[English](README.md) | 中文

零依赖的进程树终止原语，由桌面外壳（`@deepseek-ai/dsh-desktop`）与本地子进程后端（`@deepseek-ai/dsh-subprocess-local`）共享。桌面主进程与孤儿 reaper 会在关闭期间等待本原语；subprocess-local 将其用于自身 tree-kill seam 的底层实现。

## 接口面

```ts
import { killProcessTree } from '@deepseek-ai/dsh-process-tree'

declare const serverPid: number

// Terminate pid and its whole tree, then await the platform completion boundary.
await killProcessTree(serverPid)
```

一次 await 调用，永不抛错。Windows 用 `taskkill /T /F`，因为 `child.kill()` 只对直接子进程做 `TerminateProcess`，并在该命令完成后 resolve。POSIX 要求树根以 detached 方式拉起、自成进程组：负 pid 会对整个组发送 SIGTERM，在需要时于 `graceMs`（默认 5000）后升级为 SIGKILL；当信号发送和存活探测成功时，会轮询至该组消失。ESRCH 静默，因为树已经消失；其他信号发送、探测或 taskkill 启动错误经可注入的 `logger` 上报（默认 `console.error`），随后以 best-effort 方式 resolve。该 Promise 及其定时器会让桌面 reaper 这类 detached 的短命调用方存活到成功的平台完成边界。

## Model Experience

无——这是纯进程原语，不涉及任何模型请求。

#### KV Cache 影响

无——不进入请求前缀。

## Known Limitations and Deferred Work

- **Windows 无宽限阶段**——taskkill `/T /F` 立即终止；Windows 的优雅关闭通道随桌面外壳自身的 v1 决策一并推迟。
- **不校验 pid 归属**——原语会终止 pid 指向的任何进程树；调用方必须拥有所传入的 pid。
