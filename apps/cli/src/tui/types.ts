/** One line that's already happened — rendered once into the scrollback and never touched again. */
export interface TranscriptEntry {
  id: number
  /**
   * `input` is an echo of something the user typed; `activity` a finished
   * tool call; `output` is everything else (banner, answers, status).
   */
  kind: 'input' | 'output' | 'activity'
  text: string
}

/**
 * What the Ink component exposes once it has mounted. `TuiIo` (see tui-io.ts)
 * is written against this instead of talking to Ink directly, so the REPL/
 * approval-prompt code doesn't need to know Ink exists.
 */
export interface TuiHandlers {
  /** Append a finished line to the scrollback transcript. */
  appendEntry(entry: Omit<TranscriptEntry, 'id'>): void
  /**
   * Show the given label next to the input box and resolve with whatever the
   * user submits. Resolves `null` on Ctrl+D (EOF) with an empty input box.
   * Only one request is ever outstanding at a time — the CLI is a single
   * REPL loop, so this is never called concurrently with itself.
   */
  requestInput(label: string): Promise<string | null>
  /** A transient line shown above the input box (e.g. "thinking…"), or `null` to clear it. */
  setStatus(text: string | null): void
  /**
   * The reply being generated right now, repainted in place as it grows, or
   * `null` once it is finished and has moved into the transcript.
   */
  setLive(text: string | null): void
  /** The tool call running right now, or `null` once it has finished. */
  setActivity(text: string | null): void
}
