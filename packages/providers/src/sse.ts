export interface SseEvent {
  /** The `event:` field, when the stream names its events (Anthropic does). */
  event?: string
  data: string
}

/**
 * Reads a `text/event-stream` body one event at a time.
 *
 * Network chunks fall wherever they like — mid-event, mid-line, even inside a
 * multi-byte UTF-8 character — so bytes are decoded in streaming mode and
 * only complete events, ended by a blank line, are yielded. Comment lines
 * (`: keep-alive`, OpenRouter's `: OPENROUTER PROCESSING`) carry nothing and
 * are skipped.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      // A `\r` at the very end may be the first half of a `\r\n` split across
      // chunks. Normalised alone it would become a line end of its own, and
      // with the `\n` that follows read as the blank line ending an event.
      const held = !done && buffer.endsWith('\r') ? '\r' : ''
      buffer = buffer.slice(0, buffer.length - held.length).replace(/\r\n?/g, '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = parseEvent(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        if (event) yield event
      }
      buffer += held
      if (done) break
    }
    // A stream that stops without the final blank line still delivered its
    // last event.
    const last = parseEvent(buffer)
    if (last) yield last
  } finally {
    // Reached early when the consumer stops reading — an error event, say —
    // and then the connection is no longer wanted. On a finished stream it
    // does nothing.
    reader.cancel().catch(() => {})
  }
}

function parseEvent(block: string): SseEvent | null {
  let event: string | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
  }
  return data.length ? { event, data: data.join('\n') } : null
}

/**
 * The body of a response that was asked to stream, as events — or `null` when
 * the server answered with plain JSON instead. Some OpenAI-compatible servers
 * ignore `stream: true`, and a caller that falls back to parsing the JSON
 * still gets its answer, just all at once.
 */
export function sseBody(response: Response): ReadableStream<Uint8Array> | null {
  const type = response.headers?.get('content-type') ?? ''
  if (!response.body || !type.includes('text/event-stream')) return null
  return response.body
}

/**
 * Thrown when a stream closes before the provider said the reply was done. A
 * proxy timing out or a server restarting can end the body cleanly part-way
 * through, and without this the half reply would be returned, and logged, as
 * if it were the whole answer. Thrown instead, it is retried like any other
 * failed request.
 */
export class IncompleteStreamError extends Error {
  override readonly name = 'IncompleteStreamError'

  constructor(provider: string) {
    super(`${provider}: stream ended before the reply was complete`)
  }
}
