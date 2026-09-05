import { describe, expect, it } from 'vitest'
import { formatResponse, isTextualContentType, readCappedBody } from './response.js'

function streamed(chunks: string[], headers: Record<string, string>): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { headers })
}

describe('isTextualContentType', () => {
  it('accepts text and the JSON/XML families', () => {
    for (const type of ['text/html', 'application/json; charset=utf-8', 'application/problem+json', 'text/csv']) {
      expect(isTextualContentType(type)).toBe(true)
    }
  })

  it('rejects binary types', () => {
    for (const type of ['image/png', 'application/octet-stream', 'video/mp4', '']) {
      expect(isTextualContentType(type)).toBe(false)
    }
  })
})

describe('readCappedBody', () => {
  it('returns a whole small body untruncated', async () => {
    const body = await readCappedBody(new Response('{"a":1}', { headers: { 'content-type': 'application/json' } }), 100)
    expect(body).toMatchObject({ text: '{"a":1}', truncated: false, byteLength: 7 })
  })

  it('stops reading a streaming body at the ceiling', async () => {
    const body = await readCappedBody(streamed(['abcde', 'fghij', 'klmno'], { 'content-type': 'text/plain' }), 7)
    expect(body.text).toBe('abcdefg')
    expect(body.truncated).toBe(true)
    expect(body.byteLength).toBe(7)
  })

  it('does not call a body that exactly fills the ceiling truncated', async () => {
    const body = await readCappedBody(streamed(['abcde'], { 'content-type': 'text/plain' }), 5)
    expect(body).toMatchObject({ text: 'abcde', truncated: false })
  })

  it('caps a body that arrives already buffered, without a stream', async () => {
    const fake = {
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'abcdefghij',
    } as unknown as Response
    expect(await readCappedBody(fake, 4)).toMatchObject({ text: 'abcd', truncated: true })
  })

  it('reads but does not decode a binary body', async () => {
    const body = await readCappedBody(new Response('png', { headers: { 'content-type': 'image/png' } }), 100)
    expect(body.text).toBeUndefined()
    expect(body.byteLength).toBe(3)
  })
})

describe('formatResponse', () => {
  it('lays out status, headers and body', () => {
    const response = new Response('{"a":1}', { status: 201, statusText: 'Created', headers: { 'x-req': '7' } })
    const text = formatResponse(response, { text: '{"a":1}', byteLength: 7, truncated: false, contentType: '' })
    expect(text).toContain('HTTP 201 Created')
    expect(text).toContain('x-req: 7')
    expect(text.endsWith('{"a":1}')).toBe(true)
  })

  it('marks a truncated body', () => {
    const text = formatResponse(new Response('ab'), { text: 'ab', byteLength: 2, truncated: true, contentType: '' })
    expect(text).toContain('[truncated at 2 bytes]')
  })

  it('summarises a binary body instead of pasting it', () => {
    const text = formatResponse(new Response(null), { byteLength: 9000, truncated: true, contentType: 'image/png' })
    expect(text).toContain('[image/png body not shown')
    expect(text).toContain('9000+ bytes]')
  })
})
