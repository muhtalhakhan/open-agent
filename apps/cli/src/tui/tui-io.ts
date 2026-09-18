import type { ReplIO } from '../repl.js'
import type { TuiHandlers } from './types.js'

/**
 * Bridges the plain async `ReplIO` interface (and the `ask()` shape the
 * terminal approval handler wants) onto a live Ink component.
 *
 * The component itself doesn't exist yet when `main()` starts wiring things
 * up, so this class can be constructed first and handed to `runRepl`/
 * `createTerminalApprovalHandler` immediately; every method just awaits
 * `bind()` having been called once Ink has mounted and registered its
 * handlers via `onReady`.
 */
export class TuiIo implements ReplIO {
  private handlers: TuiHandlers | null = null
  private readonly ready: Promise<void>
  private resolveReady!: () => void
  private readonly ended: Promise<null>
  private resolveEnded!: (value: null) => void

  constructor() {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve
    })
    this.ended = new Promise((resolve) => {
      this.resolveEnded = resolve
    })
  }

  /** Called once by the Ink root component after it mounts. */
  bind(handlers: TuiHandlers): void {
    this.handlers = handlers
    this.resolveReady()
  }

  async prompt(): Promise<string | null> {
    const handlers = await this.handlersReady()
    return Promise.race([handlers.requestInput('> '), this.ended])
  }

  /**
   * Ends input as Ctrl+D would: the pending prompt, and every one after it,
   * answers EOF. Quitting this way rather than exiting the process lets the
   * session finish like `:exit` does — background jobs stopped, session saved.
   */
  end(): void {
    this.resolveEnded(null)
  }

  write(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.handlers?.appendEntry({ kind: 'output', text: trimmed })
  }

  setStatus(text: string | null): void {
    this.handlers?.setStatus(text)
  }

  /** Matches the `ask(question) => Promise<string>` shape `createTerminalApprovalHandler` expects. */
  ask = async (question: string): Promise<string> => {
    const handlers = await this.handlersReady()
    const answer = await handlers.requestInput(question)
    return answer ?? ''
  }

  private async handlersReady(): Promise<TuiHandlers> {
    await this.ready
    if (!this.handlers) throw new Error('TuiIo: bind() must be called by the Ink root before use')
    return this.handlers
  }
}
