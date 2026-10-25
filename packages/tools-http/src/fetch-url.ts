import type { NetworkPolicy, ToolDefinition, ToolResult } from '@open-agent/agent'
import { createGuardedFetch } from './guarded-fetch.js'
import { htmlToText } from './html-text.js'
import { isTextualContentType, readCappedBody } from './response.js'

/** Download ceiling: a long article is well under it, a video is not read past it. */
const DEFAULT_MAX_DOWNLOAD_BYTES = 2_000_000
/** What the model is given of one page; `start` reads on from there. */
const DEFAULT_MAX_CHARS = 40_000
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT_MS = 30_000

export interface FetchUrlToolOptions {
  /** Denied hosts and whether local addresses may be reached; loopback and private ones are refused by default. */
  network?: NetworkPolicy
  fetchFn?: typeof fetch
  lookupFn?: ((hostname: string) => Promise<string[]>) | null
  maxDownloadBytes?: number
  maxChars?: number
  timeoutMs?: number
}

type FetchUrlArgs = {
  url: string
  start?: number
}

const SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Absolute http(s) URL of the page.' },
    start: {
      type: 'number',
      description: 'Character offset to start from, to read on through a long page (default 0).',
    },
  },
  required: ['url'],
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

/**
 * A web page's readable text, without starting a browser: cheaper by far
 * for reading an article, docs or a README, and the browser stays for pages
 * that need clicking.
 *
 * `safe`, like `browser_navigate`: it reads and sends nothing but the URL.
 * A URL can still carry data out in its query string, which is what the
 * registry's exfiltration rule is for, and it applies to `safe` tools too.
 * What comes back is the page's own text, so it is untrusted output.
 */
export function fetchUrlTool(options: FetchUrlToolOptions = {}): ToolDefinition<FetchUrlArgs> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const guarded = createGuardedFetch({
    policy: { ...options.network },
    fetchFn: options.fetchFn,
    lookupFn: options.lookupFn,
    maxRedirects: DEFAULT_MAX_REDIRECTS,
  })

  return {
    name: 'fetch_url',
    description:
      'Fetch a web page and return its readable text (title, headings, paragraphs, list items, and links as ' +
      '"text (url)"). Use it to read an article, documentation or a README without the browser. Long pages come ' +
      'back a part at a time; pass start to read on.',
    schema: SCHEMA,
    permissionLevel: 'safe',
    untrustedOutput: true,
    async execute(args, context) {
      if (typeof args.url !== 'string' || !args.url.trim()) return fail('url is required')
      const start = args.start ?? 0
      if (!Number.isInteger(start) || start < 0) return fail('start must be a whole number, 0 or more')

      const controller = new AbortController()
      const onAbort = () => controller.abort(context.signal.reason)
      if (context.signal.aborted) onAbort()
      context.signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs)

      try {
        const { response, url } = await guarded.fetch(args.url.trim(), {
          method: 'GET',
          headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
          signal: controller.signal,
        })
        const contentType = response.headers.get('content-type') ?? ''
        if (!response.ok) return fail(`HTTP ${response.status} from ${url}`)
        if (!isTextualContentType(contentType)) {
          return fail(`${url} is ${contentType.split(';')[0] || 'of no stated type'}, not a web page or text`)
        }
        const read = await readCappedBody(response, options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES)
        const raw = read.text ?? ''
        const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype html|html)/i.test(raw)
        const { title, text } = isHtml ? htmlToText(raw) : { title: undefined, text: raw.trim() }

        if (start >= text.length && text.length > 0)
          return fail(`start ${start} is past the end (${text.length} characters)`)
        const part = text.slice(start, start + maxChars)
        const notes: string[] = []
        if (start + maxChars < text.length) {
          notes.push(
            `[characters ${start}-${start + part.length} of ${text.length}. Read on with start=${start + part.length}.]`,
          )
        }
        if (read.truncated) notes.push('[the page was larger than the download limit; the rest was not read]')
        const head = [`URL: ${url}`, ...(title ? [`Title: ${title}`] : [])].join('\n')
        return {
          ok: true,
          content: `${head}\n\n${part || '(no readable text)'}${notes.length ? `\n\n${notes.join('\n')}` : ''}`,
        }
      } catch (err) {
        const reason = controller.signal.aborted && !context.signal.aborted ? controller.signal.reason : err
        return fail(reason instanceof Error ? reason.message : String(reason))
      } finally {
        clearTimeout(timer)
        context.signal.removeEventListener('abort', onAbort)
      }
    },
  }
}
