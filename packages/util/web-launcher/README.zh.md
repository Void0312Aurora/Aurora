# dsh-web-launcher

[English](README.md) | 中文

供外壳宿主共享的 `dsh web` 启动原语：桌面外壳（`@deepseek-ai/dsh-desktop`）与 VS Code 扩展通过本包解析、spawn 并探测 Web 服务器就绪状态。它是纯 Node 逻辑——不引入 Electron 或 VS Code——生命周期报告、UI 胶水与关停归消费方所有。

## 接口面

```ts
import { resolveWebLaunch, spawnWebLaunch, requireWebLaunchPipes, waitForReadyLine, waitForHttpOk, childExited, WEB_ARGS } from '@deepseek-ai/dsh-web-launcher'

declare const appDir: string

// 1. Decide how to launch `dsh web` (DSH_BIN → embedded closure → checkout → PATH).
const launch = resolveWebLaunch({ env: process.env, appDir, execPath: process.execPath })
// 2. Spawn through the shared compatibility boundary.
const child = spawnWebLaunch(launch, { env: process.env })
const { stdout } = requireWebLaunchPipes(child)
// 3. Wait for `dsh web: http://127.0.0.1:<port>` on stdout.
const url = await waitForReadyLine(stdout)
// 4. Poll the advertised URL until it answers HTTP 200.
await waitForHttpOk(url)
```

`resolveWebLaunch` 按固定顺序解析：`DSH_BIN` 环境变量；位于 `<appDir>/deploy/node_modules/@deepseek-ai/dsh/lib/bin.js` 的内嵌 deploy 闭包，以 Electron-as-Node 运行（`ELECTRON_RUN_AS_NODE=1` 加 `--expose-internals`，因为 harness 的 HMR 服务需要 Node internals，而 `node-addon-require-builtin` 兜底在 Electron 的 V8 下不可用）；所在 checkout 的 CLI（`<appDir>/../../apps/cli`，优先已构建的 `lib/bin.js`，否则 tsx 源码启动）；PATH 上的 `dsh`。`spawnWebLaunch` 会解析 npm 安装的 `dsh.cmd` 等 Windows 可执行 shim，同时保留参数向量；共享的 stdio、环境、工作目录、隐藏窗口与 POSIX 进程组契约归它所有。`requireWebLaunchPipes` 校验进程实现确实提供了所请求的 stdout 与 stderr 管道；生命周期所有者会先记录子进程再调用它，以便校验失败时仍能终止进程。Windows 上未设置或为空的 `DSH_PERMISSION_MODE` 回退为 `danger-full-access`，因为 harness 在该平台没有隔离后端。`waitForReadyLine` 会重组跨 chunk 拆分的行、要求显式端口（拆分片段永远无法匹配），并在就绪后继续排空流，避免存活的服务器因 EPIPE 死亡；`onChunk` 抛出的异常会报告到 stderr，但不会中断排空。`waitForHttpOk` 用剩余总期限约束每次尝试和随后等待，并接受外部 `signal`，供调用方在启动期间 dispose 时取消轮询。

## Model Experience

无——这是纯启动解析原语，不涉及任何模型请求。

#### KV Cache 影响

无——不进入请求前缀。

## Known Limitations and Deferred Work

- **就绪契约是 `dsh web: ` 这一 stdout 前缀**——服务器就绪行的变更必须在同一 PR 中同步更新 `parseReadyLine`；两者之间没有其他钉合机制。
- **checkout 发现假定 `apps/<name>` 布局**——仓库根按 `<appDir>/../..` 推导；布局之外的消费方只是错过 checkout 候选，自然落到 PATH。
