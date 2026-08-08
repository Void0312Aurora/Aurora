# dsh-process-tree

English | [中文](README.zh.md)

Zero-dependency process-tree termination shared by the desktop shell (`@deepseek-ai/dsh-desktop`) and the local subprocess backend (`@deepseek-ai/dsh-subprocess-local`). The desktop main process and orphan reaper await this primitive during shutdown; subprocess-local uses it behind its tree-kill seams.

## Surface

```ts
import { killProcessTree } from '@deepseek-ai/dsh-process-tree'

declare const serverPid: number

// Terminate pid and its whole tree, then await the platform completion boundary.
await killProcessTree(serverPid)
```

One awaited call never throws. Windows uses `taskkill /T /F` because `child.kill()` is `TerminateProcess` of the direct child only and resolves after command completion. POSIX requires the tree root to be spawned detached so it leads its own process group: a negated pid signals the whole group with SIGTERM, escalates to SIGKILL after `graceMs` (default 5000) if needed, and, when signalling and liveness probes succeed, polls until the group is absent. ESRCH is silent because the tree is already gone; other delivery, probe, or taskkill-launch errors are logged through the injectable `logger` (default `console.error`) and resolve best-effort. The Promise and its timers keep a detached, short-lived caller such as the desktop reaper alive through the successful platform completion boundary.

## Model Experience

None, as this is a pure process primitive; nothing here reaches a model request.

#### KV Cache effect

None; nothing here enters a request prefix.

## Known Limitations and Deferred Work

- **Windows gets no graceful phase** — taskkill `/T /F` terminates immediately; a Windows graceful-dispose channel is deferred with the desktop shell's own v1 decision.
- **No pid-ownership check** — the primitive terminates whatever tree the pid names; callers must own the pid they pass.
