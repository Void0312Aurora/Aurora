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
  /** Start native consumers after the runtime publishes a ready origin. */
  startNative: () => void
  /** Stop native consumers before their server generation is disposed. */
  stopNative: () => void
  /** Report a startup failure that still belongs to the current generation. */
  onStartFailure: (error: unknown) => void
}

/** One published generation plus the revocation signal for waits that use it. */
interface OwnedRuntime {
  readonly runtime: ManagedServer
  readonly revoked: Promise<void>
  readonly revoke: () => void
  disposal?: Promise<void>
}

/** Owns the current server generation and the native consumers attached to it. */
export class RuntimeLifecycle {
  private owner: OwnedRuntime | undefined
  private restartTask: Promise<void> | undefined
  private disposed = false
  private disposeTask: Promise<void> | undefined

  /** @param options - runtime factory, native hooks, and failure sink. */
  constructor(private readonly options: RuntimeLifecycleOptions) {}

  /** Current ready origin; consumers call this for every operation. */
  readonly origin = (): URL | undefined => this.owner?.runtime.url

  /** Ensure one generation and its native consumers are running. */
  start(): void {
    if (this.restartTask !== undefined) return
    void this.startGeneration().catch(() => undefined)
  }

  /** Start or reuse a generation outside an in-progress restart barrier. */
  private async startGeneration(): Promise<void> {
    if (this.disposed) return
    const current = this.owner ??= this.createOwner()
    try {
      // Teardown must not depend on a server generation reaching readiness.
      // Revocation releases this transaction even when start() remains
      // pending; disposeOwned() independently tears down the exact runtime.
      await Promise.race([current.runtime.start().then(() => undefined), current.revoked])
      // The native clients resolve the current origin when they connect. Do
      // not start them before runtime.start() publishes that origin: an early
      // stream attempt has no endpoint and can miss the first interaction
      // frame while the server is still booting.
      if (this.owns(current)) this.options.startNative()
    } catch (error) {
      // A restart or deactivate may dispose a generation while start awaits
      // readiness. Its rejection belongs to teardown, not the replacement.
      if (!this.owns(current)) return
      this.options.onStartFailure(error)
      throw error
    }
  }

  /** Re-read ownership after an await (the generation may have been replaced). */
  private owns(owner: OwnedRuntime): boolean {
    return !this.disposed && this.owner === owner
  }

  /** Publish a revocable owner before its runtime crosses any await. */
  private createOwner(): OwnedRuntime {
    let revoke = (): void => {}
    const revoked = new Promise<void>((resolve) => { revoke = resolve })
    return { runtime: this.options.createRuntime(), revoked, revoke }
  }

  /** Revoke and unpublish the current generation synchronously. */
  private detachOwner(): OwnedRuntime | undefined {
    const current = this.owner
    this.owner = undefined
    current?.revoke()
    return current
  }

  /** Dispose one exact generation once. */
  private disposeOwned(owner: OwnedRuntime | undefined): Promise<void> {
    if (owner === undefined) return Promise.resolve()
    owner.disposal ??= owner.runtime.dispose()
    return owner.disposal
  }

  /** Dispose the current generation, then start a replacement. */
  restart(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.restartTask !== undefined) return this.restartTask
    this.options.stopNative()
    const current = this.detachOwner()
    const task = (async () => {
      await this.disposeOwned(current)
      await this.startGeneration()
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
    // Detach first: if restart already published a replacement whose start()
    // is still pending, revocation immediately releases the restart barrier.
    const currentDisposal = this.disposeOwned(this.detachOwner())
    await Promise.all([this.restartTask ?? Promise.resolve(), currentDisposal])
  }
}
