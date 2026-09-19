/**
 * A queue in front of readline, so no line of input is ever emitted to nobody.
 *
 * `rl.question()` listens for one line at a time. readline, though, emits a
 * `line` event for every line of a chunk it reads, synchronously and whether
 * or not anyone is waiting: the first answers the pending question, and the
 * rest are dropped. That is why `printf 'a\nb\n:exit\n' | open-agent` ran `a`
 * and silently discarded the rest, and why a line typed while a task was
 * running was lost.
 *
 * Subscribing once, at the moment the interface exists, fixes both. It also
 * retires the rule that no `await` may sit between `createInterface()` and the
 * first prompt: lines that arrive during a slow startup wait in the queue
 * instead of being read and thrown away. That rule had already been broken in
 * practice — with `FILES_TOOL=1` or `SHELL_TOOL=1` the CLI awaits a workspace
 * before its first prompt, and `echo task | open-agent` lost the task itself.
 */

/** The part of readline this needs, so tests can drive it with a bare emitter. */
export interface LineSource {
  on(event: 'line', listener: (line: string) => void): unknown
  on(event: 'close', listener: () => void): unknown
  setPrompt(prompt: string): void
  prompt(): void
}

export interface LineReader {
  /** The next line, or `null` once input has ended and the queue is drained. */
  next(prompt: string): Promise<string | null>
  /**
   * Drops lines that arrived before now.
   *
   * For an approval prompt on a terminal. A queue makes a line typed ahead as
   * the *next task* available to answer a question that appears a moment
   * later — a task beginning "yes, and..." would approve a tool the user never
   * saw asked about. Anything typed before the question was on screen was not
   * an answer to it, so it is not treated as one. The typed-ahead line is lost,
   * which is the safe side of that trade.
   */
  discardQueued(): void
}

/**
 * The approval prompt's reader, sharing the REPL's queue.
 *
 * It must be the same queue: two readers on one stdin would race, and a
 * scripted answer could be taken as a task or a task as an answer. What
 * differs is what a line typed *before* the question counts as.
 *
 * On a terminal it counts as nothing. The user was typing their next task,
 * not answering a question they had not seen, and letting it through would
 * mean a line starting "yes" could approve a tool call that appeared
 * afterwards. Piped input is the opposite case: a script's answers were
 * written in order, knowing which prompts would come, so the next line is
 * exactly what it intended as the answer.
 */
export function createApprovalAsk(reader: LineReader, isTty: boolean): (question: string) => Promise<string> {
  return async (question: string) => {
    if (isTty) reader.discardQueued()
    // EOF answers nothing, and the empty string is refused by every caller.
    return (await reader.next(question)) ?? ''
  }
}

export function createLineReader(rl: LineSource): LineReader {
  const queued: string[] = []
  let waiting: ((line: string | null) => void) | undefined
  let closed = false

  rl.on('line', (line) => {
    if (waiting) {
      const resolve = waiting
      // Cleared before resolving: the continuation may call next() again
      // synchronously, and it must not find itself already registered.
      waiting = undefined
      resolve(line)
      return
    }
    queued.push(line)
  })

  rl.on('close', () => {
    closed = true
    // A pending question at close would otherwise never settle, leaving the
    // session to drain away unsaved with nothing holding the event loop open.
    const resolve = waiting
    waiting = undefined
    resolve?.(null)
  })

  return {
    next(prompt: string): Promise<string | null> {
      // Queued lines come first even after close, so input that arrived in the
      // final chunk still runs rather than being lost to the EOF that followed
      // it in the same breath.
      const line = queued.shift()
      if (line !== undefined) return Promise.resolve(line)
      if (closed) return Promise.resolve(null)
      rl.setPrompt(prompt)
      rl.prompt()
      return new Promise((resolve) => (waiting = resolve))
    },
    discardQueued(): void {
      queued.length = 0
    },
  }
}
