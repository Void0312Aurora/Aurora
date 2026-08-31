/**
 * Serialized ownership for the extension's one managed server runtime.
 * Start publication is asynchronous, while restart and deactivation detach
 * the owned runtime before awaiting its disposer. A synchronous deactivation
 * flag prevents an already queued restart or late readiness completion from
 * publishing work after extension teardown begins.
 */

/** Minimum lifecycle face required from the managed runtime. */
export interface ManagedRuntime {
  /** Begin the runtime and settle when it is ready. */
  start(): Promise<unknown>
  /** Stop owned work and await teardown. */
  dispose(): Promise<void>
  /** Whether teardown has already claimed this runtime. */
  readonly isDisposed: boolean
}

/** Hooks around runtime construction and readiness. */
export interface RuntimeLifecycleOptions<T extends ManagedRuntime> {
  /** Construct one unpublished runtime candidate. */
  create(): T
  /** Called only while the ready runtime remains current and activation is live. */
  onReady(runtime: T): void | Promise<void>
  /** Report a genuine startup failure after cleanup. */
  onStartError(error: unknown): void
}

interface RuntimeOwnership<T extends ManagedRuntime> {
  runtime: T
  revoked: Promise<void>
  revoke(): void
  disposal?: Promise<void>
}

function ownRuntime<T extends ManagedRuntime>(runtime: T): RuntimeOwnership<T> {
  let revoke!: () => void
  const revoked = new Promise<void>((resolve) => { revoke = resolve })
  return { runtime, revoked, revoke }
}

/** Lifecycle transaction for one replaceable runtime. */
export class RuntimeLifecycle<T extends ManagedRuntime> {
  private currentOwner: RuntimeOwnership<T> | undefined
  private tail: Promise<void> = Promise.resolve()
  private deactivated = false

  /** @param options - runtime factory and readiness/error hooks. */
  constructor(private readonly options: RuntimeLifecycleOptions<T>) {}

  /** The runtime currently owned by this lifecycle, including while it starts. */
  get current(): T | undefined {
    return this.currentOwner?.runtime
  }

  /** Queue an idempotent start without waiting for server readiness. */
  start(): Promise<void> {
    return this.enqueue(() => {
      if (this.deactivated || this.currentOwner !== undefined) return
      void this.launch().catch(() => undefined)
    })
  }

  /** Dispose the current runtime, then launch one replacement if activation remains live. */
  restart(): Promise<void> {
    return this.enqueue(async () => {
      const current = this.detach()
      await this.dispose(current)
      if (!this.deactivated) await this.launch()
    })
  }

  /** Permanently close publication and await disposal of the currently owned runtime. */
  deactivate(): Promise<void> {
    this.deactivated = true
    // Revocation and disposal begin synchronously instead of waiting behind a
    // restart whose replacement may still be inside start()/onReady(). The
    // launch races this token, so revocation also releases that queue entry.
    const disposing = this.dispose(this.detach())
    return this.enqueue(() => disposing)
  }

  private launch(): Promise<void> {
    if (this.deactivated || this.currentOwner !== undefined) return Promise.resolve()
    let candidate: T
    try {
      candidate = this.options.create()
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.options.onStartError(failure)
      return Promise.reject(failure)
    }
    const owner = ownRuntime(candidate)
    this.currentOwner = owner
    const started = Promise.resolve().then(() => candidate.start()).then(
      async () => {
        if (this.deactivated || this.currentOwner !== owner) return
        await this.options.onReady(candidate)
      },
    )
    const ready = Promise.race([started, owner.revoked])
    void ready.catch((error: unknown) => {
      void this.enqueue(async () => {
        if (this.currentOwner !== owner) return
        this.currentOwner = undefined
        owner.revoke()
        const teardown = this.deactivated || candidate.isDisposed
        try {
          await this.dispose(owner)
        } catch (disposeError) {
          if (!teardown) {
            this.options.onStartError(new AggregateError([error, disposeError], 'runtime startup and cleanup failed'))
          }
          return
        }
        if (!teardown) this.options.onStartError(error)
      })
    })
    return ready
  }

  private detach(): RuntimeOwnership<T> | undefined {
    const owner = this.currentOwner
    if (owner === undefined) return undefined
    this.currentOwner = undefined
    owner.revoke()
    return owner
  }

  private dispose(owner: RuntimeOwnership<T> | undefined): Promise<void> {
    if (owner === undefined) return Promise.resolve()
    owner.disposal ??= Promise.resolve().then(() => owner.runtime.dispose())
    return owner.disposal
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const next = this.tail.then(operation, operation)
    this.tail = next.catch(() => {})
    return next
  }
}
