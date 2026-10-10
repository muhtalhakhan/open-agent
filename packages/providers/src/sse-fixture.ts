/**
 * Test-only: a `text/event-stream` response whose bytes arrive in pieces of
 * `chunkSize`, so events — and multi-byte characters — are split across reads
 * the way a real network splits them.
 */
export function sseResponse(events: Array<{ event?: string; data: unknown }>, chunkSize = 7): Response {
  const text = events
    .map(
      ({ event, data }) =>
        `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
    )
    .join('')
  const bytes = new TextEncoder().encode(text)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** Collects what an `onText` callback is given, and the text it adds up to. */
export function recordText() {
  const events: Array<{ type: 'delta'; text: string } | { type: 'reset' }> = []
  return {
    events,
    onText: (event: (typeof events)[number]) => void events.push(event),
    text: () => events.map((e) => (e.type === 'delta' ? e.text : '')).join(''),
  }
}
