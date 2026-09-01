/**
 * A minimal, from-scratch reimplementation of the core ideas behind Cordis
 * (the plugin kernel under DeepSeek Harness): a context is a repository of
 * services keyed by name, plugins declare their service dependencies via
 * `inject` and only activate once those services exist, and every
 * registration (a listener, a service, a plugin) is a reversible effect that
 * unwinds when its owning scope disposes.
 *
 * This is not a port of Cordis's source — it re-derives the same five ideas
 * (plugin, context, inject, typed events, reversible effects) in a much
 * smaller surface tailored to the agent runtime.
 */

export type Disposer = () => void

export type PluginFunction<C = unknown> = (ctx: Context, config: C) => void | Disposer

export interface PluginObject<C = unknown> {
  name?: string
  inject?: string[]
  apply: PluginFunction<C>
}

export type Plugin<C = unknown> = PluginFunction<C> | PluginObject<C>

interface Listener {
  fn: (...args: any[]) => any
  prepend: boolean
}

interface PendingPlugin {
  plugin: Plugin<any>
  config: unknown
  inject: string[]
}

/**
 * A single node in the context tree. The root context and every plugin
 * scope share the same service map (services are global), but each scope
 * owns its own disposers so a plugin can be torn down independently.
 */
export class Context {
  private readonly services: Map<string, unknown>
  private readonly listeners: Map<string, Listener[]>
  private readonly pending: Set<PendingPlugin>
  private readonly disposers: Disposer[] = []
  private disposed = false

  constructor(private readonly parent?: Context) {
    if (parent) {
      this.services = parent.services
      this.listeners = parent.listeners
      this.pending = parent.pending
    } else {
      this.services = new Map()
      this.listeners = new Map()
      this.pending = new Set()
    }
  }

  /** Look up a service by its context key (e.g. "tools", "llm", "sessions"). */
  get<T = unknown>(key: string): T | undefined {
    return this.services.get(key) as T | undefined
  }

  /** True if every named service is currently registered. */
  hasAll(keys: string[]): boolean {
    return keys.every((key) => this.services.has(key))
  }

  /**
   * Register a service under a context key. Throws if the key is already
   * taken, since exactly one provider should own a seam at a time. Returns
   * a disposer that removes the service again.
   */
  set<T>(key: string, value: T): Disposer {
    if (this.services.has(key)) {
      throw new Error(`service "${key}" is already registered`)
    }
    this.services.set(key, value)
    this.tryPending()
    const dispose = () => {
      if (this.services.get(key) === value) this.services.delete(key)
    }
    this.disposers.push(dispose)
    return dispose
  }

  /**
   * Mount a plugin. If the plugin declares `inject` dependencies that are
   * not yet satisfied, it is queued and retried automatically every time a
   * new service is registered. Returns a disposer that tears the plugin
   * (and everything it registered) down.
   */
  plugin<C>(plugin: Plugin<C>, config?: C): Disposer {
    const inject = typeof plugin === 'function' ? [] : plugin.inject ?? []
    const scope = new Context(this)

    const activate = (): Disposer => {
      const apply = typeof plugin === 'function' ? plugin : plugin.apply
      const dispose = apply(scope, config as C)
      if (typeof dispose === 'function') scope.disposers.push(dispose)
      return () => scope.dispose()
    }

    if (this.hasAll(inject)) {
      const dispose = activate()
      this.disposers.push(dispose)
      return dispose
    }

    const entry: PendingPlugin = { plugin, config, inject }
    this.pending.add(entry)
    let activated = false
    let realDispose: Disposer = () => {}
    const tryActivate = () => {
      if (activated || !this.hasAll(entry.inject)) return
      activated = true
      this.pending.delete(entry)
      realDispose = activate()
    }
    // stash the retry so tryPending() (fired on every ctx.set) can call it
    ;(entry as any).__retry = tryActivate
    const dispose = () => {
      this.pending.delete(entry)
      if (activated) realDispose()
    }
    this.disposers.push(dispose)
    return dispose
  }

  private tryPending() {
    for (const entry of [...this.pending]) {
      ;(entry as any).__retry?.()
    }
  }

  /** Register a plain listener for an `emit`/`parallel`/`serial` event. */
  on(event: string, fn: (...args: any[]) => any, options: { prepend?: boolean } = {}): Disposer {
    const list = this.listeners.get(event) ?? []
    const entry: Listener = { fn, prepend: !!options.prepend }
    if (entry.prepend) list.unshift(entry)
    else list.push(entry)
    this.listeners.set(event, list)
    const dispose = () => {
      const cur = this.listeners.get(event)
      if (!cur) return
      const i = cur.indexOf(entry)
      if (i >= 0) cur.splice(i, 1)
    }
    this.disposers.push(dispose)
    return dispose
  }

  /** Fire-and-forget: listeners run synchronously in order, no return value. */
  emit(event: string, ...args: any[]): void {
    for (const { fn } of this.listeners.get(event) ?? []) fn(...args)
  }

  /**
   * Around-middleware: each listener receives `(value, ...args, next)` and
   * either calls `next(value)` to delegate or returns to short-circuit.
   */
  waterfall<T>(event: string, initial: T, ...args: any[]): T {
    const chain = this.listeners.get(event) ?? []
    const dispatch = (i: number, value: T): T => {
      if (i >= chain.length) return value
      const { fn } = chain[i]
      const next = (v: T) => dispatch(i + 1, v)
      return fn(value, ...args, next)
    }
    return dispatch(0, initial)
  }

  /** All listeners run concurrently; the call resolves once every one does. */
  async parallel(event: string, ...args: any[]): Promise<void> {
    await Promise.all((this.listeners.get(event) ?? []).map(({ fn }) => fn(...args)))
  }

  /** Listeners run one after another, awaited; results are collected in order. */
  async serial<T = unknown>(event: string, ...args: any[]): Promise<T[]> {
    const results: T[] = []
    for (const { fn } of this.listeners.get(event) ?? []) results.push(await fn(...args))
    return results
  }

  /** Listeners run in order until one returns a defined value; that value wins. */
  bail<T = unknown>(event: string, ...args: any[]): T | undefined {
    for (const { fn } of this.listeners.get(event) ?? []) {
      const result = fn(...args)
      if (result !== undefined) return result
    }
    return undefined
  }

  /** Register a reversible side effect scoped to this plugin/context. */
  effect(fn: () => Disposer | void): void {
    const dispose = fn()
    if (typeof dispose === 'function') this.disposers.push(dispose)
  }

  /** Tear down everything this scope (and its plugins) registered. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    while (this.disposers.length) this.disposers.pop()!()
  }
}
