import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { editFileTool } from './edit-file.js'

let root: string
const ctx = { taskId: 't1', signal: new AbortController().signal }

async function seed(relative: string, content: string): Promise<void> {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

const read = (relative: string) => fs.readFile(path.join(root, relative), 'utf8')

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-file-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('editFileTool', () => {
  it('asks, like any write', () => {
    expect(editFileTool({ root }).permissionLevel).toBe('ask')
  })

  it('replaces the one occurrence and leaves the rest of the file alone', async () => {
    await seed('a.ts', 'const a = 1\nconst b = 2\nconst c = 3\n')

    const result = await editFileTool({ root }).execute({ path: 'a.ts', old_text: 'b = 2', new_text: 'b = 20' }, ctx)

    expect(result).toEqual({ ok: true, content: 'edited a.ts: replaced 1 occurrence' })
    expect(await read('a.ts')).toBe('const a = 1\nconst b = 20\nconst c = 3\n')
  })

  it('takes new_text literally, $ patterns included', async () => {
    await seed('a.txt', 'price: X\n')

    await editFileTool({ root }).execute({ path: 'a.txt', old_text: 'X', new_text: "$& and $1 and $'" }, ctx)

    expect(await read('a.txt')).toBe("price: $& and $1 and $'\n")
  })

  it('refuses an ambiguous match unless replace_all is set, and then changes every one', async () => {
    await seed('a.txt', 'foo\nbar\nfoo\n')
    const tool = editFileTool({ root })

    expect(await tool.execute({ path: 'a.txt', old_text: 'foo', new_text: 'baz' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/occurs 2 times/),
    })
    expect(await read('a.txt')).toBe('foo\nbar\nfoo\n')

    expect(await tool.execute({ path: 'a.txt', old_text: 'foo', new_text: 'baz', replace_all: true }, ctx)).toEqual({
      ok: true,
      content: 'edited a.txt: replaced 2 occurrences',
    })
    expect(await read('a.txt')).toBe('baz\nbar\nbaz\n')
  })

  it.each([
    [{ path: 'a.txt', old_text: 'missing', new_text: 'x' }, /was not found/],
    [{ path: 'a.txt', old_text: '', new_text: 'x' }, /cannot be empty/],
    [{ path: 'a.txt', old_text: 'same', new_text: 'same' }, /nothing to change/],
    [{ path: 'gone.txt', old_text: 'a', new_text: 'b' }, /no such file/],
    [{ path: '../outside.txt', old_text: 'a', new_text: 'b' }, /outside the workspace/],
  ])('refuses %j', async (args, error) => {
    await seed('a.txt', 'same text\n')

    expect(await editFileTool({ root }).execute(args, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(error),
    })
    expect(await read('a.txt')).toBe('same text\n')
  })

  it('follows the file policy and a read-only workspace', async () => {
    await seed('.env', 'KEY=1\n')
    await seed('a.txt', 'a\n')

    expect(await editFileTool({ root }).execute({ path: '.env', old_text: '1', new_text: '2' }, ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/file policy/),
    })
    expect(
      await editFileTool({ root, policy: { readOnly: true } }).execute(
        { path: 'a.txt', old_text: 'a', new_text: 'b' },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) })
  })

  it('previews the exact edit as a diff in plan mode, without writing', async () => {
    await seed('a.txt', 'one\ntwo\n')

    const preview = await editFileTool({ root }).plan!({ path: 'a.txt', old_text: 'two', new_text: 'TWO' }, ctx)

    expect(preview.ok).toBe(true)
    expect(preview.content).toContain('-two')
    expect(preview.content).toContain('+TWO')
    expect(await read('a.txt')).toBe('one\ntwo\n')
  })
})
