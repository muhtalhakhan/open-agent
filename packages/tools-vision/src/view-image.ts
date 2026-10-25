import fs from 'node:fs/promises'
import path from 'node:path'
import type { NetworkPolicy, ToolDefinition, ToolResult } from '@open-agent/agent'
import {
  FilePolicyError,
  WorkspaceError,
  checkAccess,
  resolvePathInWorkspace,
  type FilePolicy,
} from '@open-agent/tools-files'
import { createGuardedFetch } from '@open-agent/tools-http'

/** What vision models take, by the extension of a file or the type a server sends. */
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const ACCEPTED = new Set(Object.values(IMAGE_TYPES))
/** Above what providers accept for one image, so a bigger one fails here with a clear reason. */
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_ANSWER_TOKENS = 1_000
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_QUESTION = 'Describe this image in detail, including any text in it.'

export interface ViewImageToolOptions {
  /** The OpenAI-compatible endpoint and key the agent already uses. */
  baseURL: string
  apiKey: string
  /** A model on that endpoint that can see images. */
  model: string
  /** The workspace images may be read from, with its file policy. Without one, only URLs are accepted. */
  root?: string
  policy?: FilePolicy
  /** Where an image URL may be fetched from; local and private addresses are refused by default. */
  network?: NetworkPolicy
  fetchFn?: typeof fetch
  lookupFn?: ((hostname: string) => Promise<string[]>) | null
  maxImageBytes?: number
  timeoutMs?: number
}

type ViewImageArgs = {
  image: string
  question?: string
}

const SCHEMA = {
  type: 'object',
  properties: {
    image: {
      type: 'string',
      description: 'The image: a path relative to the workspace root, or an http(s) URL. PNG, JPEG, WebP or GIF.',
    },
    question: {
      type: 'string',
      description: 'What to find out about it. Default: a detailed description, including any text in it.',
    },
  },
  required: ['image'],
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

class ImageError extends Error {}

/**
 * Asks a vision model about an image, so an agent whose own model cannot
 * see — or cannot be sent pictures through `LlmAdapter`, which carries text
 * — can still read a screenshot, a chart or a photo of a page.
 *
 * `safe`: it reads an image the agent can already reach, from the workspace
 * under the file policy or from a URL under the network policy, and sends it
 * to the provider that already sees the whole conversation. The answer is
 * untrusted: text in an image is whatever its author put there, instructions
 * included.
 */
export function viewImageTool(options: ViewImageToolOptions): ToolDefinition<ViewImageArgs> {
  const maxBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchFn = options.fetchFn ?? fetch
  const guarded = createGuardedFetch({
    policy: { ...options.network },
    fetchFn: options.fetchFn,
    lookupFn: options.lookupFn,
    maxRedirects: 5,
  })

  const fromWorkspace = async (requested: string): Promise<{ type: string; bytes: Buffer }> => {
    if (!options.root) throw new ImageError('no workspace is configured, so give the image as an http(s) URL')
    const resolved = await resolvePathInWorkspace(options.root, requested)
    checkAccess(resolved.relative, 'read', options.policy)
    const type = IMAGE_TYPES[path.extname(resolved.absolute).toLowerCase()]
    if (!type) throw new ImageError(`"${requested}" is not a PNG, JPEG, WebP or GIF file`)
    const stats = await fs.stat(resolved.absolute).catch(() => {
      throw new ImageError(`no such file: "${requested}"`)
    })
    if (!stats.isFile()) throw new ImageError(`"${requested}" is not a regular file`)
    if (stats.size > maxBytes)
      throw new ImageError(`"${requested}" is ${stats.size} bytes, over the ${maxBytes}-byte limit`)
    return { type, bytes: await fs.readFile(resolved.absolute) }
  }

  const fromUrl = async (url: string, signal: AbortSignal): Promise<{ type: string; bytes: Buffer }> => {
    const { response, url: final } = await guarded.fetch(url, { method: 'GET', headers: { Accept: 'image/*' }, signal })
    if (!response.ok) throw new ImageError(`HTTP ${response.status} from ${final}`)
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!ACCEPTED.has(type))
      throw new ImageError(`${final} is ${type || 'of no stated type'}, not a PNG, JPEG, WebP or GIF image`)
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > maxBytes) throw new ImageError(`${final} is ${declared} bytes, over the ${maxBytes}-byte limit`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new ImageError(`${final} is over the ${maxBytes}-byte limit`)
    return { type, bytes }
  }

  return {
    name: 'view_image',
    description:
      'Look at an image — a screenshot, chart, diagram, photo or scanned page — with a vision model and get an answer ' +
      'to a question about it (by default a detailed description, including any text). The image is a workspace path ' +
      'or an http(s) URL.',
    schema: SCHEMA,
    permissionLevel: 'safe',
    untrustedOutput: true,
    async execute(args, context) {
      if (typeof args.image !== 'string' || !args.image.trim()) return fail('image is required')
      const question =
        typeof args.question === 'string' && args.question.trim() ? args.question.trim() : DEFAULT_QUESTION

      const controller = new AbortController()
      const onAbort = () => controller.abort(context.signal.reason)
      if (context.signal.aborted) onAbort()
      context.signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      try {
        const source = args.image.trim()
        const image = /^https?:\/\//i.test(source)
          ? await fromUrl(source, controller.signal)
          : await fromWorkspace(source)

        const response = await fetchFn(`${options.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
          signal: controller.signal,
          body: JSON.stringify({
            model: options.model,
            max_tokens: DEFAULT_MAX_ANSWER_TOKENS,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: question },
                  {
                    type: 'image_url',
                    image_url: { url: `data:${image.type};base64,${image.bytes.toString('base64')}` },
                  },
                ],
              },
            ],
          }),
        })
        const text = await response.text()
        if (!response.ok) {
          // The usual cause is a model that cannot see; say which, so the fix is obvious.
          return fail(
            `the vision model (${options.model}) refused the request: HTTP ${response.status} ${text.slice(0, 300)}`,
          )
        }
        let answer: unknown
        try {
          answer = (JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message
            ?.content
        } catch {
          return fail(`the vision model sent back something that is not JSON: ${text.slice(0, 200)}`)
        }
        if (typeof answer !== 'string' || !answer.trim()) return fail('the vision model returned no answer')
        return { ok: true, content: answer.trim() }
      } catch (err) {
        if (err instanceof ImageError || err instanceof FilePolicyError || err instanceof WorkspaceError)
          return fail(err.message)
        const reason = controller.signal.aborted && !context.signal.aborted ? controller.signal.reason : err
        return fail(reason instanceof Error ? reason.message : String(reason))
      } finally {
        clearTimeout(timer)
        context.signal.removeEventListener('abort', onAbort)
      }
    },
  }
}
