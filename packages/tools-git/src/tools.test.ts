import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitBranchTool } from './branch.js'
import { gitCommitTool } from './commit.js'
import { gitDiffTool } from './diff.js'
import { gitLogTool } from './log.js'
import { gitStatusTool } from './status.js'
import { makeRepo, sh } from './test-repo.js'

const context = { taskId: 't', signal: new AbortController().signal }

let root: string
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), content)
}
const head = () => sh(root, 'rev-parse', 'HEAD').trim()
const staged = () => sh(root, 'diff', '--cached', '--name-only').trim()

beforeEach(() => {
  root = makeRepo()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('git_status', () => {
  it('shows the branch, staged, changed and untracked files, and the branches', async () => {
    write('README.md', 'changed\n')
    write('new.txt', 'new\n')
    write('staged.txt', 'staged\n')
    sh(root, 'add', 'staged.txt')
    sh(root, 'branch', 'other')

    const { ok, content } = await gitStatusTool({ root }).execute({}, context)

    expect(ok).toBe(true)
    expect(content).toContain('## main')
    expect(content).toMatch(/^ M README\.md$/m)
    expect(content).toMatch(/^A {2}staged\.txt$/m)
    expect(content).toMatch(/^\?\? new\.txt$/m)
    expect(content).toContain('Local branches: main (current), other')
  })

  it('says so when the tree is clean', async () => {
    expect((await gitStatusTool({ root }).execute({}, context)).content).toContain('working tree is clean')
  })
})

describe('git_diff', () => {
  beforeEach(() => {
    write('.env', 'SECRET=one\n')
    sh(root, 'add', '--force', '.env')
    sh(root, 'commit', '--quiet', '-m', 'tracked env')
  })

  it('shows unstaged changes, or staged ones', async () => {
    write('README.md', 'hello\nworld\n')
    const tool = gitDiffTool({ root })

    expect((await tool.execute({}, context)).content).toContain('+world')
    expect((await tool.execute({ staged: true }, context)).content).toBe('No changes.')

    sh(root, 'add', 'README.md')
    expect((await tool.execute({}, context)).content).toBe('No changes.')
    expect((await tool.execute({ staged: true }, context)).content).toContain('+world')
  })

  it('compares with a ref, narrows to a path, and summarises with stat', async () => {
    write('a.txt', 'a\n')
    write('README.md', 'hello\nmore\n')
    sh(root, 'add', '.')
    sh(root, 'commit', '--quiet', '-m', 'second')
    const tool = gitDiffTool({ root })

    const againstFirst = (await tool.execute({ ref: 'HEAD~1' }, context)).content
    expect(againstFirst).toContain('a.txt')
    expect(againstFirst).toContain('+more')
    expect((await tool.execute({ ref: 'HEAD~1', path: 'a.txt' }, context)).content).not.toContain('README')
    expect((await tool.execute({ ref: 'HEAD~1', stat: true }, context)).content).toMatch(/2 files changed/)
  })

  it('leaves out files the policy denies, without their contents ever appearing', async () => {
    write('.env', 'SECRET=two\n')
    write('README.md', 'visible\n')

    const { content } = await gitDiffTool({ root }).execute({}, context)

    expect(content).toContain('+visible')
    expect(content).not.toContain('SECRET')
    expect(content).toContain('left out by the workspace file policy: .env')
  })

  it('refuses a ref that would read as an option, and a path outside the workspace', async () => {
    const tool = gitDiffTool({ root })

    expect(await tool.execute({ ref: '--output=/tmp/x' }, context)).toMatchObject({ ok: false })
    expect(await tool.execute({ ref: 'no-such-branch' }, context)).toMatchObject({
      ok: false,
      error: '"no-such-branch" is not a commit, branch or tag here',
    })
    expect(await tool.execute({ path: '../outside' }, context)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/outside the workspace/),
    })
  })
})

describe('git_log', () => {
  it('lists commits newest first, as many as asked for', async () => {
    write('a.txt', 'a\n')
    sh(root, 'add', 'a.txt')
    sh(root, 'commit', '--quiet', '-m', 'second')

    const all = (await gitLogTool({ root }).execute({}, context)).content.split('\n')
    expect(all).toHaveLength(2)
    expect(all[0]).toMatch(/^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} Test: second$/)
    expect((await gitLogTool({ root }).execute({ count: 1 }, context)).content.split('\n')).toHaveLength(1)
    expect((await gitLogTool({ root }).execute({ path: 'a.txt' }, context)).content).not.toContain('first')
  })
})

describe('git_commit', () => {
  it('stages the named paths, new files included, and commits them', async () => {
    write('a.txt', 'a\n')
    write('b.txt', 'b\n')

    const result = await gitCommitTool({ root }).execute({ message: 'Add a\n\nBecause.', paths: ['a.txt'] }, context)

    expect(result).toMatchObject({ ok: true, content: expect.stringMatching(/^Committed on main:/) })
    expect(sh(root, 'log', '-1', '--format=%B').trim()).toBe('Add a\n\nBecause.')
    expect(sh(root, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('a.txt')
    expect(sh(root, 'status', '--short')).toContain('?? b.txt')
  })

  it('stages every tracked change with all, and leaves untracked files alone', async () => {
    write('README.md', 'changed\n')
    write('untracked.txt', 'u\n')

    expect((await gitCommitTool({ root }).execute({ message: 'update', all: true }, context)).ok).toBe(true)
    expect(sh(root, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('README.md')
  })

  it('takes a message that starts with a dash as a message', async () => {
    write('a.txt', 'a\n')

    expect((await gitCommitTool({ root }).execute({ message: '--amend', paths: ['a.txt'] }, context)).ok).toBe(true)
    expect(sh(root, 'log', '--format=%s').split('\n').filter(Boolean)).toEqual(['--amend', 'first'])
  })

  it.each([
    ['named', { paths: ['.env'] }],
    ['swept up by all', { all: true }],
    ['already staged', {}],
  ])('refuses a file the policy denies when it is %s, changing nothing', async (_, args) => {
    write('.env', 'SECRET=x\n')
    sh(root, 'add', '--force', '.env')
    sh(root, 'commit', '--quiet', '-m', 'tracked env')
    write('.env', 'SECRET=y\n')
    if (Object.keys(args).length === 0) sh(root, 'add', '.env')
    const before = { head: head(), staged: staged() }

    const result = await gitCommitTool({ root }).execute({ message: 'leak', ...args }, context)

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/file policy excludes: \.env/) })
    expect({ head: head(), staged: staged() }).toEqual(before)
  })

  it('judges each file a directory would stage, not the directory', async () => {
    write('src/app.ts', 'code\n')
    write('src/.env', 'SECRET=x\n')
    const before = { head: head(), staged: staged() }

    const result = await gitCommitTool({ root }).execute({ message: 'add src', paths: ['src'] }, context)

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/file policy excludes: src\/\.env/) })
    expect({ head: head(), staged: staged() }).toEqual(before)
  })

  it('previews every file a directory would stage', async () => {
    write('src/a.ts', 'a\n')
    write('src/b.ts', 'b\n')

    expect((await gitCommitTool({ root }).plan!({ message: 'src', paths: ['src'] }, context)).content).toContain(
      'Files:\n  src/a.ts\n  src/b.ts',
    )
  })

  it('refuses when there is nothing to commit, and in a read-only workspace', async () => {
    expect(await gitCommitTool({ root }).execute({ message: 'empty' }, context)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/nothing to commit/),
    })
    write('a.txt', 'a\n')
    expect(
      await gitCommitTool({ root, policy: { readOnly: true } }).execute({ message: 'm', paths: ['a.txt'] }, context),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) })
  })

  it('previews the commit in plan mode without staging or committing', async () => {
    write('a.txt', 'a\n')
    const before = head()

    const preview = await gitCommitTool({ root }).plan!({ message: 'Add a', paths: ['a.txt'] }, context)

    expect(preview).toEqual({ ok: true, content: 'Commit on main:\n\nAdd a\n\nFiles:\n  a.txt' })
    expect(head()).toBe(before)
    expect(staged()).toBe('')
  })
})

describe('git_branch', () => {
  it('creates a branch and switches to it, or only creates it', async () => {
    const tool = gitBranchTool({ root })

    expect(await tool.execute({ action: 'create', name: 'feat/x' }, context)).toEqual({
      ok: true,
      content: 'Created branch feat/x from the current commit and switched to it.',
    })
    expect(sh(root, 'branch', '--show-current').trim()).toBe('feat/x')

    expect((await tool.execute({ action: 'create', name: 'later', switch: false }, context)).ok).toBe(true)
    expect(sh(root, 'branch', '--show-current').trim()).toBe('feat/x')
    expect((await tool.execute({ action: 'switch', name: 'later' }, context)).ok).toBe(true)
    expect(sh(root, 'branch', '--show-current').trim()).toBe('later')
  })

  it.each([
    [{ action: 'create', name: 'bad..name' }, /not a valid branch name/],
    [{ action: 'create', name: '-D' }, /cannot start with "-"/],
    [{ action: 'create', name: 'main' }, /already exists/],
    [{ action: 'switch', name: 'nope' }, /there is no branch/],
    [{ action: 'create', name: 'x', start_point: 'no-such-ref' }, /not a commit/],
    [{ action: 'delete', name: 'main' }, /action must be/],
  ] as const)('refuses %j', async (args, error) => {
    expect(await gitBranchTool({ root }).execute(args as never, context)).toMatchObject({
      ok: false,
      error: expect.stringMatching(error),
    })
  })

  it('passes on git refusing a switch that would overwrite uncommitted changes', async () => {
    sh(root, 'checkout', '--quiet', '-b', 'other')
    write('README.md', 'other\n')
    sh(root, 'commit', '--quiet', '-am', 'other')
    sh(root, 'checkout', '--quiet', 'main')
    write('README.md', 'uncommitted\n')

    const result = await gitBranchTool({ root }).execute({ action: 'switch', name: 'other' }, context)

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/would be overwritten/) })
    expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('uncommitted\n')
  })

  it('previews in plan mode without creating anything', async () => {
    const preview = await gitBranchTool({ root }).plan!(
      { action: 'create', name: 'feat/y', start_point: 'main' },
      context,
    )

    expect(preview).toEqual({ ok: true, content: 'Create branch feat/y from main and switch to it.' })
    expect(sh(root, 'branch', '--list', 'feat/y').trim()).toBe('')
  })
})
