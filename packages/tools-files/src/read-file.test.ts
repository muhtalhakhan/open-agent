import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry } from '@open-agent/agent'
import { readFileTool } from './read-file.js'

let root: string
const ctx = { taskId: 't1', signal: new AbortController().signal }

async function write(relative: string, content: string | Buffer): Promise<string> {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  return file
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'read-file-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('readFileTool', () => {
  it('is safe: a read inside the configured root needs no approval', () => {
    expect(readFileTool({ root }).permissionLevel).toBe('safe')
  })

  it('returns the file with line numbers', async () => {
    await write('notes.txt', 'alpha\nbeta\n')
    const result = await readFileTool({ root }).execute({ path: 'notes.txt' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toBe('1\talpha\n2\tbeta')
  })

  it('pads line numbers to a common width', async () => {
    await write('long.txt', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'))
    const lines = (await readFileTool({ root }).execute({ path: 'long.txt' }, ctx)).content.split('\n')
    expect(lines[0]).toBe(' 1\tline 1')
    expect(lines[9]).toBe('10\tline 10')
  })

  it('reads a page at a time and says how to continue', async () => {
    await write('big.txt', Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'))
    const result = await readFileTool({ root }).execute({ path: 'big.txt', offset: 3, limit: 2 }, ctx)
    expect(result.content).toContain('3\tline 3')
    expect(result.content).toContain('4\tline 4')
    expect(result.content).not.toContain('line 5')
    expect(result.content).toContain('offset=5')
  })

  it('caps a single call at maxLines even when the model asks for more', async () => {
    await write('big.txt', Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'))
    const result = await readFileTool({ root, maxLines: 3 }).execute({ path: 'big.txt', limit: 50 }, ctx)
    expect(result.content.split('\n').filter((line) => line.includes('\t'))).toHaveLength(3)
  })

  it('stops at the byte ceiling and marks where it stopped', async () => {
    await write('big.txt', Array.from({ length: 100 }, () => 'x'.repeat(50)).join('\n'))
    const result = await readFileTool({ root, maxBytes: 200 }).execute({ path: 'big.txt' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('200-byte ceiling')
  })

  it('clips a single enormous line instead of spending the whole budget on it', async () => {
    await write('bundle.js', `${'a'.repeat(5000)}\nsecond`)
    const result = await readFileTool({ root }).execute({ path: 'bundle.js' }, ctx)
    expect(result.content).toContain('[line truncated]')
    expect(result.content).toContain('2\tsecond')
  })

  it('reports an empty file rather than returning nothing', async () => {
    await write('empty.txt', '')
    const result = await readFileTool({ root }).execute({ path: 'empty.txt' }, ctx)
    expect(result).toEqual({ ok: true, content: 'empty.txt is empty' })
  })

  it('rejects an offset past the end and says how long the file is', async () => {
    await write('notes.txt', 'a\nb\n')
    const result = await readFileTool({ root }).execute({ path: 'notes.txt', offset: 9 }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('past the end')
    expect(result.error).toContain('2 lines')
  })

  it('rejects a non-integer offset', async () => {
    await write('notes.txt', 'a\n')
    const result = await readFileTool({ root }).execute({ path: 'notes.txt', offset: 0 }, ctx)
    expect(result.error).toBe('offset must be a positive integer')
  })

  it('refuses a binary file', async () => {
    await write('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x01]))
    const result = await readFileTool({ root }).execute({ path: 'image.png' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('binary')
  })

  it('refuses a directory, and says so', async () => {
    await fs.mkdir(path.join(root, 'src'))
    const result = await readFileTool({ root }).execute({ path: 'src' }, ctx)
    expect(result.error).toContain('is a directory')
  })

  it('reports a missing file', async () => {
    const result = await readFileTool({ root }).execute({ path: 'nope.txt' }, ctx)
    expect(result.error).toBe('no such file: "nope.txt"')
  })

  it('refuses to escape the workspace root', async () => {
    const result = await readFileTool({ root }).execute({ path: '../../etc/passwd' }, ctx)
    expect(result.error).toContain('outside the workspace root')
  })

  it('refuses a symlink that points out of the workspace root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'read-file-outside-'))
    await fs.writeFile(path.join(outside, 'secret.txt'), 'shh')
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
    try {
      const result = await readFileTool({ root }).execute({ path: 'link.txt' }, ctx)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('symlink')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('requires a path', async () => {
    const result = await readFileTool({ root }).execute({} as { path: string }, ctx)
    expect(result.error).toBe('path is required')
  })

  it('honours a cancelled signal', async () => {
    await write('big.txt', Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'))
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))
    const result = await readFileTool({ root }).execute(
      { path: 'big.txt' },
      { taskId: 't1', signal: controller.signal },
    )
    expect(result.error).toBe('user cancelled')
  })

  it('runs through the registry without approval', async () => {
    await write('notes.txt', 'hello\n')
    const registry = new ToolRegistry()
    registry.register(readFileTool({ root }))
    const result = await registry.execute({ id: '1', name: 'read_file', args: { path: 'notes.txt' } }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toBe('1\thello')
  })

  it('refuses to read a file the policy denies', async () => {
    await write('.env', 'OPENAI_API_KEY=sk-live-secret')
    const result = await readFileTool({ root }).execute({ path: '.env' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('excluded by the workspace file policy')
    expect(result.content).not.toContain('sk-live-secret')
  })

  it('still reads .env.example, which holds names and no values', async () => {
    await write('.env.example', 'OPENAI_API_KEY=')
    expect((await readFileTool({ root }).execute({ path: '.env.example' }, ctx)).ok).toBe(true)
  })

  it('honours an extra deny pattern from the caller', async () => {
    await write('internal/notes.md', 'private')
    const tool = readFileTool({ root, policy: { deny: ['internal/**'] } })
    expect((await tool.execute({ path: 'internal/notes.md' }, ctx)).error).toContain('file policy')
  })
})
