/**
 * Turning an arbitrary HTTP response into something safe to append to a
 * transcript. The concern here is the model's context window: an API that
 * answers with a 40 MB JSON dump, a video, or a never-ending event stream
 * must not be able to push the rest of the conversation out. So the body is
 * read with a hard byte ceiling and the connection dropped once it is hit,
 * and a non-textual body is summarised rather than pasted.
 */

/** Textual enough to show the model. Everything else is reported by type and size. */
const TEXTUAL =
  /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ecmascript|x-www-form-urlencoded|.*\+json|.*\+xml))/i

export interface ReadBody {
  /** Decoded body, absent when the content type is not textual. */
  text?: string
  /** Bytes actually read — equal to the whole body unless `truncated`. */
  byteLength: number
  truncated: boolean
  contentType: string
}

export function isTextualContentType(contentType: string): boolean {
  return TEXTUAL.test(contentType.trim())
}

/**
 * Reads at most `maxBytes` of the body. Streams where the runtime gives us a
 * reader (so a chunked or endless response is cut off at the source instead
 * of being buffered whole), and falls back to `text()` for responses that
 * expose no stream.
 */
export async function readCappedBody(response: Response, maxBytes: number): Promise<ReadBody> {
  const contentType = response.headers.get('content-type') ?? ''
  const textual = isTextualContentType(contentType)

  const { bytes, truncated } = await readBytes(response, maxBytes)
  const byteLength = bytes.byteLength
  if (!textual) return { byteLength, truncated, contentType }
  return { text: new TextDecoder().decode(bytes), byteLength, truncated, contentType }
}

async function readBytes(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader?.()
  if (!reader) {
    // A hand-rolled or already-buffered response: nothing to stop early, so
    // just cut the buffer down to the ceiling.
    const bytes = new TextEncoder().encode(await response.text())
    return bytes.byteLength > maxBytes
      ? { bytes: bytes.subarray(0, maxBytes), truncated: true }
      : { bytes, truncated: false }
  }

  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const remaining = maxBytes - total
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining))
        total = maxBytes
        truncated = true
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
    // Hitting the ceiling exactly is only a truncation if more was coming.
    if (!truncated && total === maxBytes) {
      const { done } = await reader.read()
      truncated = !done
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, truncated }
}

/** `status`, then headers, then the body (or a stand-in for a non-textual one). */
export function formatResponse(response: Response, body: ReadBody): string {
  const headers = [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n')
  const lines = [`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`]
  if (headers) lines.push(headers)

  if (body.text === undefined) {
    lines.push(
      '',
      `[${body.contentType || 'unknown content type'} body not shown — ${body.byteLength}${body.truncated ? '+' : ''} bytes]`,
    )
  } else {
    lines.push('', body.text)
    if (body.truncated) lines.push(`\n[truncated at ${body.byteLength} bytes]`)
  }
  return lines.join('\n')
}
