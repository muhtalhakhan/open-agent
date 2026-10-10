import type { RunTextEvent } from '@open-agent/agent'
import { createMarkdownRenderer, type MarkdownRenderer } from './markdown.js'

/**
 * Shows one task's replies while they are generated. The REPL makes one per
 * task and hands its `onText` to the agent loop.
 */
export interface AnswerStream {
  onText(event: RunTextEvent): void
  /**
   * Whether the reply that ended last reached the screen as it streamed. When
   * it did, that reply was the answer and the REPL must not print it again;
   * when the provider doesn't stream, nothing was shown and the REPL prints
   * the answer as it always has.
   */
  lastShown(): boolean
  /** The task is over: shows whatever is still held back, such as a reply cut short by Ctrl+C. */
  close(): void
}

/** Said when a retry or a provider switch takes back a reply that was already partly on screen. */
export const RESTART_NOTICE = '[reply interrupted — starting over]'

/**
 * For the plain REPL, writing straight to the terminal.
 *
 * With `markdown`, a reply is printed a line at a time, each line styled as
 * it completes: the renderer is line-based, so a finished line renders the
 * same as it would in the whole answer, while a half-written one cannot be
 * styled yet and is held until its newline. Without it — output piped, or
 * `NO_COLOR` — text is written the moment it arrives.
 *
 * Nothing printed can be taken back, so a reset is announced rather than
 * hidden, and the next attempt prints below it.
 */
export function createTerminalAnswerStream(
  write: (text: string) => void,
  { markdown = false }: { markdown?: boolean } = {},
): AnswerStream {
  let started = false
  let shown = false
  let pending = ''
  let atLineStart = true
  let renderer: MarkdownRenderer | undefined = markdown ? createMarkdownRenderer() : undefined

  const writeLines = (lines: string[]) => {
    for (const line of lines) write(`${line}\n`)
  }

  const clear = () => {
    started = false
    pending = ''
    atLineStart = true
    renderer = markdown ? createMarkdownRenderer() : undefined
  }

  /** Closes off the current reply. Returns whether it had shown anything. */
  const finish = (): boolean => {
    if (!started) return false
    if (renderer) {
      if (pending) writeLines(renderer.line(pending))
      writeLines(renderer.end())
    } else if (!atLineStart) {
      write('\n')
    }
    // A blank line after each reply, as a whole answer has always had.
    write('\n')
    clear()
    return true
  }

  return {
    onText(event) {
      switch (event.type) {
        case 'delta': {
          if (!event.text) return
          if (!started) {
            started = true
            write('\n')
          }
          if (!renderer) {
            write(event.text)
            atLineStart = event.text.endsWith('\n')
            return
          }
          const lines = (pending + event.text).replace(/\r\n/g, '\n').split('\n')
          pending = lines.pop() ?? ''
          for (const line of lines) writeLines(renderer.line(line))
          return
        }
        case 'reset':
          if (!started) return
          write(`${atLineStart ? '' : '\n'}${RESTART_NOTICE}\n`)
          clear()
          return
        case 'end':
          shown = finish()
          return
      }
    },
    lastShown: () => shown,
    close() {
      finish()
    },
  }
}
