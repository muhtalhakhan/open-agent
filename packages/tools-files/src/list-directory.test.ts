import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listDirectoryTool } from './list-directory.js'

let root: string
const ctx = { taskId: 't1', signal: new AbortController().signal }

async function seed(relative: string, content = ''): Promise<void> {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

const list = (args: Record<string, unknown> = {}) => listDirectoryTool({ root }).execute(args, ctx)

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'list-dir-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('listDirectoryTool', () => {
  it('is safe: a listing inside the configured root needs no approval', () => {
    expect(listDirectoryTool({ root }).permissionLevel).toBe('safe')
  })

  it('lists directories first, then files with their size', async () => {
    await seed('b.txt', 'hello')
    await seed('a.txt', 'hi')
    await fs.mkdir(path.join(root, 'src'))

    const result = await list()

    expect(result.ok).toBe(true)
    expect(result.content).toBe('src/\na.txt\t2\nb.txt\t5')
  })

  it('defaults to the workspace root when no path is given', async () => {
    await seed('only.txt')
    expect((await list()).content).toBe('only.txt\t0')
  })

  it('lists a subdirectory', async () => {
    await seed('src/index.ts', 'x')
    expect((await list({ path: 'src' })).content).toBe('index.ts\t1')
  })

  it('stays shallow unless asked to recurse', async () => {
    await seed('src/deep/nested.ts')
    expect((await list({ path: 'src' })).content).toBe('deep/')
  })

  it('recurses with paths relative to the listed directory', async () => {
    await seed('src/deep/nested.ts')
    const result = await list({ recursive: true })
    expect(result.content.split('\n').sort()).toEqual(['src/', 'src/deep/', 'src/deep/nested.ts\t0'])
  })

  it.each(['node_modules', '.git', 'dist'])('hides %s by default', async (noisy) => {
    await seed(`${noisy}/thing.js`)
    await seed('keep.txt')
    expect((await list()).content).toBe('keep.txt\t0')
  })

  it('shows dot-files and vendor directories when all is set', async () => {
    await seed('.env', 'SECRET=1')
    const result = await list({ all: true })
    expect(result.content).toContain('.env')
  })

  it('reports an empty directory rather than empty output', async () => {
    expect((await list()).content).toBe('. is empty')
  })

  it('truncates at the entry ceiling with a note saying so', async () => {
    for (let index = 0; index < 5; index += 1) await seed(`file-${index}.txt`)
    const result = await listDirectoryTool({ root, maxEntries: 3 }).execute({}, ctx)
    expect(result.content.split('\n')).toHaveLength(5) // 3 entries, a blank line, the note
    expect(result.content).toContain('[stopped at 3 entries')
  })

  it.each([
    ['a traversal above the root', '..'],
    ['an absolute path outside the root', '/etc'],
  ])('refuses %s', async (_label, target) => {
    const result = await list({ path: target })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('outside the workspace root')
  })

  it('reports a file as not a directory', async () => {
    await seed('notes.txt')
    expect((await list({ path: 'notes.txt' })).error).toBe('"notes.txt" is not a directory')
  })

  it('reports a missing directory by the path the model wrote', async () => {
    expect((await list({ path: 'nope' })).error).toBe('no such directory: "nope"')
  })

  it('honours a cancelled task', async () => {
    await seed('a.txt')
    const controller = new AbortController()
    controller.abort()
    const result = await listDirectoryTool({ root }).execute({}, { taskId: 't1', signal: controller.signal })
    expect(result.ok).toBe(false)
  })
})
