import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { globToRegExp } from './filters.js'
import { searchFilesTool } from './search-files.js'

let root: string
const ctx = { taskId: 't1', signal: new AbortController().signal }

async function seed(relative: string, content: string | Buffer = ''): Promise<void> {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

const search = (args: Record<string, unknown>) => searchFilesTool({ root }).execute(args, ctx)

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'search-files-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('searchFilesTool', () => {
  it('is safe: searching inside the configured root needs no approval', () => {
    expect(searchFilesTool({ root }).permissionLevel).toBe('safe')
  })

  it('returns path:line: text for each match', async () => {
    await seed('a.txt', 'alpha\nbeta\n')
    await seed('b.txt', 'gamma\n')

    const result = await search({ query: 'beta' })

    expect(result.ok).toBe(true)
    expect(result.content).toBe('a.txt:2: beta')
  })

  it('finds matches across nested directories', async () => {
    await seed('src/deep/x.ts', 'needle here')
    expect((await search({ query: 'needle' })).content).toBe('src/deep/x.ts:1: needle here')
  })

  it('treats the query as literal text by default', async () => {
    await seed('a.txt', 'cost is 1+1\nsomething else')
    expect((await search({ query: '1+1' })).content).toBe('a.txt:1: cost is 1+1')
  })

  it('treats the query as a regex when asked', async () => {
    await seed('a.txt', 'foo123bar')
    expect((await search({ query: 'foo\\d+bar', regex: true })).content).toBe('a.txt:1: foo123bar')
  })

  it('reports an invalid regex as a tool failure, not a throw', async () => {
    await seed('a.txt', 'x')
    const result = await search({ query: '(unclosed', regex: true })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not a valid regular expression')
  })

  it('is case-insensitive by default and exact when asked', async () => {
    await seed('a.txt', 'Alpha')
    expect((await search({ query: 'alpha' })).content).toBe('a.txt:1: Alpha')
    expect((await search({ query: 'alpha', case_sensitive: true })).content).toContain('no matches')
  })

  it('narrows the search with a glob', async () => {
    await seed('keep.ts', 'needle')
    await seed('skip.md', 'needle')
    expect((await search({ query: 'needle', glob: '*.ts' })).content).toBe('keep.ts:1: needle')
  })

  it('matches a glob against nested paths, not only top-level names', async () => {
    await seed('src/deep/x.ts', 'needle')
    expect((await search({ query: 'needle', glob: '*.ts' })).content).toBe('src/deep/x.ts:1: needle')
  })

  it('lists matching files when given a glob and no query', async () => {
    await seed('a.ts')
    await seed('b.md')
    expect((await search({ glob: '*.ts' })).content).toBe('a.ts')
  })

  it('requires at least one of query or glob', async () => {
    const result = await search({})
    expect(result.error).toBe('give a query to search for, a glob to match filenames, or both')
  })

  it('skips binary files rather than pasting them in', async () => {
    await seed('bin.dat', Buffer.from([0x6e, 0x00, 0x65, 0x65]))
    await seed('text.txt', 'nee')
    expect((await search({ query: 'nee' })).content).toBe('text.txt:1: nee')
  })

  it('skips node_modules by default and searches it when all is set', async () => {
    await seed('node_modules/pkg/index.js', 'needle')
    expect((await search({ query: 'needle' })).content).toContain('no matches')
    expect((await search({ query: 'needle', all: true })).content).toContain('node_modules/pkg/index.js')
  })

  it('searches only under the given path', async () => {
    await seed('src/a.txt', 'needle')
    await seed('docs/b.txt', 'needle')
    expect((await search({ query: 'needle', path: 'docs' })).content).toBe('b.txt:1: needle')
  })

  it('stops at the match ceiling with a note saying so', async () => {
    await seed('many.txt', Array.from({ length: 10 }, () => 'needle').join('\n'))
    const result = await searchFilesTool({ root, maxMatches: 3 }).execute({ query: 'needle' }, ctx)
    expect(result.content.split('\n').filter((line) => line.startsWith('many.txt'))).toHaveLength(3)
    expect(result.content).toContain('[stopped at 3 matches')
  })

  it('clips a very long matching line', async () => {
    await seed('min.js', `${'x'.repeat(600)}needle`)
    const result = await search({ query: 'needle' })
    expect(result.content).toContain('[clipped]')
    expect(result.content.length).toBeLessThan(600)
  })

  it('reports no matches without failing', async () => {
    await seed('a.txt', 'nothing here')
    const result = await search({ query: 'needle' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('no matches')
  })

  it.each([
    ['a traversal above the root', '..'],
    ['an absolute path outside the root', '/etc'],
  ])('refuses %s', async (_label, target) => {
    const result = await search({ query: 'x', path: target })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('outside the workspace root')
  })

  it('honours a cancelled task', async () => {
    await seed('a.txt', 'needle')
    const controller = new AbortController()
    controller.abort()
    const result = await searchFilesTool({ root }).execute(
      { query: 'needle' },
      { taskId: 't1', signal: controller.signal },
    )
    expect(result.ok).toBe(false)
  })
})

describe('globToRegExp', () => {
  it.each([
    ['*.ts', 'index.ts', true],
    ['*.ts', 'index.tsx', false],
    // A single star stays within one path segment.
    ['*.ts', 'src/index.ts', false],
    ['src/*.ts', 'src/index.ts', true],
    ['**/*.test.ts', 'a/b/x.test.ts', true],
    // A doubled star also matches zero directories, so the pattern need not be written twice.
    ['**/*.test.ts', 'x.test.ts', true],
    ['?.ts', 'a.ts', true],
    ['?.ts', 'ab.ts', false],
    // Regex metacharacters in a glob are literal.
    ['a.ts', 'axts', false],
  ])('%s matches %s: %s', (glob, candidate, expected) => {
    expect(globToRegExp(glob, true).test(candidate)).toBe(expected)
  })

  it('is case-insensitive when asked', () => {
    expect(globToRegExp('*.TS', false).test('index.ts')).toBe(true)
    expect(globToRegExp('*.TS', true).test('index.ts')).toBe(false)
  })
})
