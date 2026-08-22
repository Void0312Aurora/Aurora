/**
 * Runtime generation coordinator shared by the panel command paths. The
 * extension keeps the panel alive across a server restart, so every consumer
 * resolves the current origin through this owner instead of retaining the
 * disposed generation.
 */

/** Server operations the extension lifecycle owns. */
export interface ManagedServer {
  /** Advertised origin after readiness. */
  readonly url: URL | undefined
  /** Start the generation and resolve after readiness. */
  start(): Promise<URL>
  /** Stop this exact generation and await its process teardown. */
  dispose(): Promise<void>
}

/** Dependencies and lifecycle hooks supplied by the VS Code entry. */
export interface RuntimeLifecycleOptions {
  /** Create one fresh managed-server generation. */
  createRuntime: () => ManagedServer
  /** Start native consumers; they resolve the origin through {@link RuntimeLifecycle.origin}. */
  startNative: () => void
  /** Stop native consumers before their server generation is disposed. */
  stopNative: () => void
  /** Report a startup failure that still belongs to the current generation. */
  onStartFailure: (error: unknown) => void
}

/** Owns the current server generation and the native consumers attached to it. */
export class RuntimeLifecycle {
  private runtime: ManagedServer | undefined
  private restartTask: Promise<void> | undefined
  private disposed = false
  private disposeTask: Promise<void> | undefined

  /** @param options - runtime factory, native hooks, and failure sink. */
  constructor(private readonly options: RuntimeLifecycleOptions) {}

  /** Current ready origin; consumers call this for every operation. */
  readonly origin = (): URL | undefined => this.runtime?.url

  /** Ensure one generation and its native consumers are running. */
  start(): void {
    if (this.restartTask !== undefined) return
    this.startGeneration()
  }

  /** Start or reuse a generation outside an in-progress restart barrier. */
  private startGeneration(): void {
    if (this.disposed) return
    const current = this.runtime ??= this.options.createRuntime()
    this.options.startNative()
    void current.start().catch((error: unknown) => {
      // A restart or deactivate may dispose a generation while start awaits
      // readiness. Its rejection belongs to teardown, not the replacement.
      if (this.disposed || this.runtime !== current) return
      this.options.onStartFailure(error)
    })
  }

  /** Dispose the current generation, then start a replacement. */
  restart(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.restartTask !== undefined) return this.restartTask
    this.options.stopNative()
    const current = this.runtime
    this.runtime = undefined
    const task = (async () => {
      await current?.dispose()
      this.startGeneration()
    })()
    const completion = task.finally(() => {
      if (this.restartTask === completion) this.restartTask = undefined
    })
    this.restartTask = completion
    return completion
  }

  /** Stop native consumers and await the current server generation. */
  dispose(): Promise<void> {
    this.disposeTask ??= this.performDispose()
    return this.disposeTask
  }

  private async performDispose(): Promise<void> {
    this.disposed = true
    this.options.stopNative()
    await this.restartTask
    const current = this.runtime
    this.runtime = undefined
    await current?.dispose()
  }
}
