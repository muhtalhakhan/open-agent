import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { viewImageTool, type ViewImageToolOptions } from './view-image.js'

const ctx = { taskId: 't', signal: new AbortController().signal }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
let root: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'view-image-')))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Plays the image host and the model endpoint; records what the model was sent. */
function fakeNet({ answer = 'A cat on a mat.', status = 200, images = {} as Record<string, Response> } = {}) {
  const sent: Array<{ model: string; messages: Array<{ content: Array<Record<string, unknown>> }> }> = []
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://api.test/v1/chat/completions') {
      sent.push(JSON.parse(String(init?.body)))
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test')
      return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), { status })
    }
    return images[url] ?? new Response('missing', { status: 404 })
  })
  return { fetchFn, sent }
}

const tool = (fetchFn: unknown, extra: Partial<ViewImageToolOptions> = {}) =>
  viewImageTool({
    baseURL: 'https://api.test/v1',
    apiKey: 'sk-test',
    model: 'vision-model',
    root,
    lookupFn: null,
    fetchFn: fetchFn as typeof fetch,
    ...extra,
  })

describe('viewImageTool', () => {
  it('is safe, and its answer is untrusted', () => {
    const t = tool(vi.fn())
    expect(t.permissionLevel).toBe('safe')
    expect(t.untrustedOutput).toBe(true)
  })

  it('sends a workspace image and the question to the vision model, and returns its answer', async () => {
    fs.writeFileSync(path.join(root, 'shot.png'), PNG)
    const { fetchFn, sent } = fakeNet()

    const result = await tool(fetchFn).execute({ image: 'shot.png', question: 'What animal?' }, ctx)

    expect(result).toEqual({ ok: true, content: 'A cat on a mat.' })
    expect(sent[0].model).toBe('vision-model')
    expect(sent[0].messages[0].content).toEqual([
      { type: 'text', text: 'What animal?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } },
    ])
  })

  it('asks for a description when no question is given', async () => {
    fs.writeFileSync(path.join(root, 'a.jpg'), PNG)
    const { fetchFn, sent } = fakeNet()

    await tool(fetchFn).execute({ image: 'a.jpg' }, ctx)

    expect(sent[0].messages[0].content[0]).toEqual({
      type: 'text',
      text: 'Describe this image in detail, including any text in it.',
    })
    expect(JSON.stringify(sent[0])).toContain('data:image/jpeg;base64,')
  })

  it('fetches an image URL and sends its bytes', async () => {
    const { fetchFn, sent } = fakeNet({
      images: { 'https://cdn.test/chart.webp': new Response(PNG, { headers: { 'content-type': 'image/webp' } }) },
    })

    expect((await tool(fetchFn).execute({ image: 'https://cdn.test/chart.webp' }, ctx)).ok).toBe(true)
    expect(JSON.stringify(sent[0])).toContain(`data:image/webp;base64,${PNG.toString('base64')}`)
  })

  it.each([
    ['a file the policy denies', () => fs.writeFileSync(path.join(root, 'id_rsa'), 'k'), 'id_rsa', /file policy/],
    ['a file that is not an image', () => fs.writeFileSync(path.join(root, 'a.txt'), 'x'), 'a.txt', /not a PNG/],
    ['a missing file', () => {}, 'gone.png', /no such file/],
    ['a path outside the workspace', () => {}, '../x.png', /outside the workspace/],
    ['a local address', () => {}, 'http://127.0.0.1/x.png', /./],
  ])('refuses %s without calling the model', async (_, setup, image, error) => {
    setup()
    const { fetchFn, sent } = fakeNet()

    expect(await tool(fetchFn).execute({ image }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(error),
    })
    expect(sent).toEqual([])
  })

  it('refuses an image over the size limit, and a URL that is not an image', async () => {
    fs.writeFileSync(path.join(root, 'big.png'), Buffer.alloc(20))
    const { fetchFn, sent } = fakeNet({
      images: { 'https://cdn.test/page': new Response('<html>', { headers: { 'content-type': 'text/html' } }) },
    })

    expect(await tool(fetchFn, { maxImageBytes: 10 }).execute({ image: 'big.png' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/over the 10-byte limit/),
    })
    expect(await tool(fetchFn).execute({ image: 'https://cdn.test/page' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/is text\/html, not a PNG/),
    })
    expect(sent).toEqual([])
  })

  it('takes URLs only when there is no workspace', async () => {
    const { fetchFn } = fakeNet()

    expect(await tool(fetchFn, { root: undefined }).execute({ image: 'shot.png' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/give the image as an http\(s\) URL/),
    })
  })

  it('names the model when the endpoint refuses, which usually means it cannot see', async () => {
    fs.writeFileSync(path.join(root, 'a.png'), PNG)
    const { fetchFn } = fakeNet({ status: 400 })

    expect(await tool(fetchFn).execute({ image: 'a.png' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/the vision model \(vision-model\) refused the request: HTTP 400/),
    })
  })
})
