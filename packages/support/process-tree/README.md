# dsh-process-tree

English | [中文](README.zh.md)

Zero-dependency process-tree termination shared by the desktop shell (`@deepseek-ai/dsh-desktop`): its main process and its orphan reaper used to each carry their own copy of the kill logic, and both now call this primitive. The subprocess backend's own tree-kill seams are a planned future consumer.

## Surface

```ts
import { killProcessTree } from '@deepseek-ai/dsh-process-tree'

// Terminate pid and its whole tree: taskkill /T /F on Windows; on POSIX the
// group gets SIGTERM and SIGKILL five seconds later if it ignored the signal.
killProcessTree(serverPid)
```

One call, never throws, ESRCH is silent (the tree is already gone — the desired outcome), and every other failure is logged through the injectable `logger` (default `console.error`). Windows uses `taskkill /T /F` because `child.kill()` is `TerminateProcess` of the direct child only. POSIX requires the tree root to be spawned detached so it leads its own process group: a negated pid signals the whole group — SIGTERM first, SIGKILL after `graceMs` (default 5000). The escalation timer is a plain `setTimeout`, so a detached, short-lived caller (the desktop reaper) stays alive until the force kill lands.

## Model Experience

None, as this is a pure process primitive; nothing here reaches a model request.

#### KV Cache effect

None; nothing here enters a request prefix.

## Known Limitations and Deferred Work

- **Escalation is fire-and-forget** — `killProcessTree` returns immediately after scheduling; the SIGKILL cannot be cancelled and the timer is not returned. Desktop callers (quit paths, the reaper) never needed the handle.
- **Windows gets no graceful phase** — taskkill `/T /F` terminates immediately; a Windows graceful-dispose channel is deferred with the desktop shell's own v1 decision.
- **No pid-ownership check** — the primitive signals whatever tree the pid names; callers own the responsibility that the pid is theirs (desktop only ever kills its own spawned child).
- **subprocess-local still carries its own kill seams** — `killGroup`/`taskkillProcessTree`/`signalTree` in `packages/subprocess/subprocess-local/src/spawn.ts` predate this package; migrating them is a separate step because that package's teardown races and idempotency contract differ from the desktop's escalation flow.
