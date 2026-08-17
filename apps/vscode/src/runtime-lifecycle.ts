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

/** Lifecycle transaction for one replaceable runtime. */
export class RuntimeLifecycle<T extends ManagedRuntime> {
  private currentValue: T | undefined
  private tail: Promise<void> = Promise.resolve()
  private deactivated = false

  /** @param options - runtime factory and readiness/error hooks. */
  constructor(private readonly options: RuntimeLifecycleOptions<T>) {}

  /** The runtime currently owned by this lifecycle, including while it starts. */
  get current(): T | undefined {
    return this.currentValue
  }

  /** Queue an idempotent start without waiting for server readiness. */
  start(): Promise<void> {
    return this.enqueue(() => {
      if (this.deactivated || this.currentValue !== undefined) return
      this.launch()
    })
  }

  /** Dispose the current runtime, then launch one replacement if activation remains live. */
  restart(): Promise<void> {
    return this.enqueue(async () => {
      const current = this.detach()
      await current?.dispose()
      if (!this.deactivated) this.launch()
    })
  }

  /** Permanently close publication and await disposal of the currently owned runtime. */
  deactivate(): Promise<void> {
    this.deactivated = true
    return this.enqueue(async () => {
      const current = this.detach()
      await current?.dispose()
    })
  }

  private launch(): void {
    if (this.deactivated || this.currentValue !== undefined) return
    let candidate: T
    try {
      candidate = this.options.create()
    } catch (error) {
      this.options.onStartError(error)
      return
    }
    this.currentValue = candidate
    void candidate.start().then(
      () => {
        if (this.deactivated || this.currentValue !== candidate) return
        void Promise.resolve(this.options.onReady(candidate)).catch((error: unknown) => {
          this.options.onStartError(error)
        })
      },
      (error: unknown) => {
        void this.enqueue(async () => {
          if (this.currentValue !== candidate) return
          this.currentValue = undefined
          const teardown = this.deactivated || candidate.isDisposed
          try {
            await candidate.dispose()
          } catch (disposeError) {
            if (!teardown) {
              this.options.onStartError(new AggregateError([error, disposeError], 'runtime startup and cleanup failed'))
            }
            return
          }
          if (!teardown) this.options.onStartError(error)
        })
      },
    )
  }

  private detach(): T | undefined {
    const current = this.currentValue
    this.currentValue = undefined
    return current
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const next = this.tail.then(operation, operation)
    this.tail = next.catch(() => {})
    return next
  }
}
