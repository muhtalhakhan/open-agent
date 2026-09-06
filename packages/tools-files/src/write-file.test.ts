import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeFileTool } from './write-file.js'

let root: string
const ctx = { taskId: 't1', signal: new AbortController().signal }

async function seed(relative: string, content: string): Promise<string> {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  return file
}

const read = (relative: string) => fs.readFile(path.join(root, relative), 'utf8')

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'write-file-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('writeFileTool', () => {
  it('asks: a write destroys what was there, so each one is a decision', () => {
    expect(writeFileTool({ root }).permissionLevel).toBe('ask')
  })

  it('creates a new file and says so', async () => {
    const result = await writeFileTool({ root }).execute({ path: 'notes.txt', content: 'hello' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toBe('created notes.txt (5 bytes)')
    expect(await read('notes.txt')).toBe('hello')
  })

  it('replaces an existing file and says so', async () => {
    await seed('notes.txt', 'old')
    const result = await writeFileTool({ root }).execute({ path: 'notes.txt', content: 'new' }, ctx)
    expect(result.content).toBe('replaced notes.txt (3 bytes)')
    expect(await read('notes.txt')).toBe('new')
  })

  it('creates missing parent directories', async () => {
    await writeFileTool({ root }).execute({ path: 'a/b/c/deep.txt', content: 'x' }, ctx)
    expect(await read('a/b/c/deep.txt')).toBe('x')
  })

  it('appends instead of replacing when asked', async () => {
    await seed('log.txt', 'first\n')
    const result = await writeFileTool({ root }).execute({ path: 'log.txt', content: 'second\n', append: true }, ctx)
    expect(result.content).toBe('appended to log.txt (7 bytes)')
    expect(await read('log.txt')).toBe('first\nsecond\n')
  })

  it('refuses to overwrite when create_only is set', async () => {
    await seed('notes.txt', 'keep me')
    const result = await writeFileTool({ root }).execute({ path: 'notes.txt', content: 'nope', create_only: true }, ctx)
    expect(result).toEqual({ ok: false, content: '', error: '"notes.txt" already exists' })
    expect(await read('notes.txt')).toBe('keep me')
  })

  it('leaves no temp file behind after an atomic replace', async () => {
    await seed('notes.txt', 'old')
    await writeFileTool({ root }).execute({ path: 'notes.txt', content: 'new' }, ctx)
    expect(await fs.readdir(root)).toEqual(['notes.txt'])
  })

  it.each([
    ['a traversal above the root', '../escape.txt'],
    ['an absolute path outside the root', '/tmp/escape-me.txt'],
  ])('refuses %s', async (_label, target) => {
    const result = await writeFileTool({ root }).execute({ path: target, content: 'x' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('outside the workspace root')
  })

  it('refuses to follow a symlink out of the root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-'))
    try {
      await fs.writeFile(path.join(outside, 'target.txt'), 'original')
      await fs.symlink(path.join(outside, 'target.txt'), path.join(root, 'link.txt'))

      const result = await writeFileTool({ root }).execute({ path: 'link.txt', content: 'overwritten' }, ctx)

      expect(result.ok).toBe(false)
      expect(result.error).toContain('outside the workspace root')
      expect(await fs.readFile(path.join(outside, 'target.txt'), 'utf8')).toBe('original')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses to write over a directory', async () => {
    await fs.mkdir(path.join(root, 'src'))
    const result = await writeFileTool({ root }).execute({ path: 'src', content: 'x' }, ctx)
    expect(result.error).toBe('"src" is a directory, not a file')
  })

  it('rejects content over the byte ceiling before touching the disk', async () => {
    const result = await writeFileTool({ root, maxBytes: 10 }).execute(
      { path: 'big.txt', content: 'x'.repeat(11) },
      ctx,
    )
    expect(result.error).toBe('content is 11 bytes, over the 10-byte limit for one write')
    expect(await fs.readdir(root)).toEqual([])
  })

  it('rejects a missing content argument', async () => {
    const result = await writeFileTool({ root }).execute({ path: 'notes.txt' } as never, ctx)
    expect(result.error).toBe('content is required and must be a string')
  })

  it('does not write when the task was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await writeFileTool({ root }).execute(
      { path: 'notes.txt', content: 'x' },
      { taskId: 't1', signal: controller.signal },
    )
    expect(result.ok).toBe(false)
    expect(await fs.readdir(root)).toEqual([])
  })

  it('counts bytes rather than characters for a multi-byte file', async () => {
    const result = await writeFileTool({ root }).execute({ path: 'utf.txt', content: 'héllo' }, ctx)
    expect(result.content).toBe('created utf.txt (6 bytes)')
  })

  it('refuses to write over a file the policy denies', async () => {
    await seed('.env', 'OPENAI_API_KEY=sk-live-secret')
    const result = await writeFileTool({ root }).execute({ path: '.env', content: 'clobbered' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('excluded by the workspace file policy')
    expect(await read('.env')).toBe('OPENAI_API_KEY=sk-live-secret')
  })

  it('refuses to create a denied file that does not exist yet', async () => {
    const result = await writeFileTool({ root }).execute({ path: 'certs/new.pem', content: 'x' }, ctx)
    expect(result.error).toContain('file policy')
  })

  it('refuses every write when the workspace is read-only', async () => {
    const tool = writeFileTool({ root, policy: { readOnly: true } })
    const result = await tool.execute({ path: 'notes.txt', content: 'x' }, ctx)
    expect(result.error).toBe('the workspace is read-only')
    expect(await fs.readdir(root)).toEqual([])
  })
})
