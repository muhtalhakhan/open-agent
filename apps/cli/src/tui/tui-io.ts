import type { AnswerStream } from '../answer-stream.js'
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

  /**
   * Streams a task's replies into the live area above the input, where each
   * one is repainted as it grows — so unlike the plain terminal, a reset can
   * simply wipe it. A finished reply moves into the transcript, rendered by
   * `format` the way a whole answer is.
   */
  answerStream(format: (text: string) => string = (text) => text): AnswerStream {
    let live = ''
    let shown = false
    const finish = (): boolean => {
      const text = live
      live = ''
      this.handlers?.setLive(null)
      if (!text.trim()) return false
      this.handlers?.appendEntry({ kind: 'output', text: format(text).trim() })
      return true
    }
    return {
      onText: (event) => {
        if (event.type === 'delta') {
          live += event.text
          if (live.trim()) this.handlers?.setLive(format(live).trim())
        } else if (event.type === 'reset') {
          live = ''
          this.handlers?.setLive(null)
        } else {
          shown = finish()
        }
      },
      lastShown: () => shown,
      close: () => void finish(),
    }
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
