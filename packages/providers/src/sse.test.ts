import { describe, expect, it } from 'vitest'
import { readSse } from './sse.js'

function streamOf(...chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>) {
  const out = []
  for await (const event of readSse(body)) out.push(event)
  return out
}

describe('readSse', () => {
  it('yields only complete events, however the chunks fall', async () => {
    const events = await collect(streamOf('data: {"a"', ':1}\n', '\ndata: two\n\nevent: ping\nda', 'ta: x\n\n'))
    expect(events).toEqual([{ data: '{"a":1}' }, { data: 'two' }, { event: 'ping', data: 'x' }])
  })

  it('decodes a multi-byte character split across two reads', async () => {
    const bytes = new TextEncoder().encode('data: café ✓\n\n')
    const events = await collect(streamOf(bytes.slice(0, 10), bytes.slice(10)))
    expect(events).toEqual([{ data: 'café ✓' }])
  })

  it('treats a \\r\\n split across reads as one line end, not a blank line', async () => {
    const events = await collect(streamOf('data: one\r', '\ndata: more\r\n\r\n'))
    expect(events).toEqual([{ data: 'one\nmore' }])
  })

  it('skips comments and yields a last event that has no closing blank line', async () => {
    const events = await collect(streamOf(': OPENROUTER PROCESSING\n\ndata: last'))
    expect(events).toEqual([{ data: 'last' }])
  })
})
