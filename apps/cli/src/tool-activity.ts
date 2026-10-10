import type { SessionEvent, ToolCall, ToolResult } from '@open-agent/agent'

/** Where tool calls are shown. The tracker pairs calls with results; a view only draws them. */
export interface ToolActivityView {
  /** A call has started. */
  started(call: ToolCall): void
  /** It has finished: `result` is what the tool returned, or a stand-in when the turn ended first. */
  finished(call: ToolCall, result: ToolResult, ms: number): void
}

/**
 * Turns one task's session events into calls on a view. A call is paired
 * with its result by id, and the duration is the distance between the two
 * events' timestamps — both already in the log, so nothing is timed twice.
 *
 * A turn can end with a call still open (cancelled mid-tool, or an error
 * thrown out of one). Those are finished with the turn's reason, so no view
 * is left showing a call as running forever.
 */
export function trackToolActivity(view: ToolActivityView): (event: SessionEvent) => void {
  const open = new Map<string, { call: ToolCall; at: number }>()
  return (event) => {
    if (event.type === 'tool/call') {
      open.set(event.call.id, { call: event.call, at: event.at })
      view.started(event.call)
    } else if (event.type === 'tool/result') {
      const started = open.get(event.callId)
      if (!started) return
      open.delete(event.callId)
      view.finished(started.call, event.result, event.at - started.at)
    } else if (event.type === 'turn/end') {
      for (const { call, at } of open.values()) {
        view.finished(call, { ok: false, content: '', error: event.reason }, event.at - at)
      }
      open.clear()
    }
  }
}

const ARGS_LENGTH = 80
const ERROR_LENGTH = 100

/**
 * Removes anything that would steer the terminal. Tool names, arguments and
 * above all error text come from the model or from what a tool read, so an
 * escape sequence in them is someone else's text, not formatting. Arguments
 * need it too: `JSON.stringify` escapes C0 controls but leaves C1 ones as
 * they are, and U+009B is a one-character CSI some terminals act on.
 */
function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
}

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

/** `read_file {"path":"src/a.ts"}` — the call, on one line, short enough to scan. */
export function describeCall(call: ToolCall): string {
  const args = Object.keys(call.args).length ? ` ${clip(printable(JSON.stringify(call.args)), ARGS_LENGTH)}` : ''
  return `${printable(call.name)}${args}`
}

/** `ok 42ms`, or `failed: no such file (3ms)`. */
export function describeOutcome(result: ToolResult, ms: number): string {
  if (result.ok) return `ok ${formatDuration(ms)}`
  const reason = clip(printable(result.error ?? result.content) || 'failed', ERROR_LENGTH)
  return `failed: ${reason} (${formatDuration(ms)})`
}

export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms)
  return safe < 1000 ? `${Math.round(safe)}ms` : `${(safe / 1000).toFixed(1)}s`
}

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`

/**
 * For the plain REPL and print mode's stderr: a line when a call starts and an
 * indented one when it ends. Two lines rather than one completed in place,
 * because an approval prompt can come between them — the call is what is
 * being approved, so it has to be on screen first, with the prompt below it.
 */
export function createLineActivityView(
  write: (text: string) => void,
  { color = false }: { color?: boolean } = {},
): ToolActivityView {
  const style = color ? dim : (text: string) => text
  return {
    started: (call) => write(`${style(`▸ ${describeCall(call)}`)}\n`),
    finished: (_call, result, ms) => write(`${style(`  ${describeOutcome(result, ms)}`)}\n`),
  }
}
