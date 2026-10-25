import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitBranchTool } from './branch.js'
import { gitCommitTool } from './commit.js'
import { gitDiffTool } from './diff.js'
import { openRepository } from './git.js'
import { gitStatusTool } from './status.js'
import { makeRepo, sh } from './test-repo.js'

const context = { taskId: 't', signal: new AbortController().signal }

describe('openRepository', () => {
  let root: string

  beforeEach(() => {
    root = makeRepo()
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('accepts the top level of a repository', async () => {
    await expect(openRepository(root)).resolves.toBe(root)
  })

  it('refuses a directory that is not a repository', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-plain-'))
    try {
      await expect(openRepository(plain)).rejects.toThrow(/not a git repository/)
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })

  it('refuses a subdirectory, which would let the tools reach the rest of the repository', async () => {
    fs.mkdirSync(path.join(root, 'sub'))

    await expect(openRepository(path.join(root, 'sub'))).rejects.toThrow(/not its top level/)
  })

  it.each([
    ['filter.evil.clean', 'touch pwned'],
    ['filter.evil.process', 'touch pwned'],
    ['gpg.program', 'touch pwned'],
    ['gpg.ssh.program', 'touch pwned'],
  ])('refuses a repository whose own config sets %s', async (key, value) => {
    sh(root, 'config', key, value)

    await expect(openRepository(root)).rejects.toThrow(new RegExp(`sets ${key.replace(/\./g, '\\.')}`, 'i'))
  })

  it('accepts a repository-level hooks path, which the tools override rather than refuse', async () => {
    sh(root, 'config', 'core.hooksPath', '.husky')

    await expect(openRepository(root)).resolves.toBe(root)
  })
})

describe('hardening', () => {
  let root: string
  const marker = () => path.join(root, 'hook-ran')

  beforeEach(() => {
    root = makeRepo()
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('never runs a hook the repository planted, on commit or on switching branches', async () => {
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'post-checkout']) {
      const file = path.join(root, '.git', 'hooks', hook)
      fs.writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${marker()}"\n`, { mode: 0o755 })
    }
    // A hooks path in the repository's config is overridden all the same.
    sh(root, 'config', 'core.hooksPath', '.git/hooks')
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')

    expect((await gitCommitTool({ root }).execute({ message: 'add a', paths: ['a.txt'] }, context)).ok).toBe(true)
    expect((await gitBranchTool({ root }).execute({ action: 'create', name: 'work' }, context)).ok).toBe(true)
    expect((await gitBranchTool({ root }).execute({ action: 'switch', name: 'main' }, context)).ok).toBe(true)

    expect(fs.existsSync(marker())).toBe(false)
  })

  it('never looks inside a submodule, whose own config was never checked', async () => {
    const source = makeRepo()
    try {
      fs.writeFileSync(path.join(source, 'f.txt'), 'x\n')
      fs.writeFileSync(path.join(source, '.gitattributes'), '*.txt filter=evil\n')
      sh(source, 'add', '.')
      sh(source, 'commit', '--quiet', '-m', 'with attributes')
      sh(root, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', source, 'mod')
      sh(root, 'commit', '--quiet', '-m', 'add submodule')
      // What the sandboxed shell could plant: a filter in the submodule's own
      // config, and a same-size edit that makes git hash the file through it.
      sh(path.join(root, 'mod'), 'config', 'filter.evil.clean', `sh -c 'touch "${marker()}"; cat'`)
      fs.writeFileSync(path.join(root, 'mod', 'f.txt'), 'y\n')

      expect((await gitStatusTool({ root }).execute({}, context)).ok).toBe(true)
      expect((await gitDiffTool({ root }).execute({}, context)).ok).toBe(true)
      expect((await gitCommitTool({ root }).execute({ message: 'm', all: true }, context)).ok).toBe(false)

      expect(fs.existsSync(marker())).toBe(false)
    } finally {
      fs.rmSync(source, { recursive: true, force: true })
    }
  })

  it('ignores GIT_DIR and the like in the environment it was started from', async () => {
    const elsewhere = makeRepo()
    sh(elsewhere, 'checkout', '--quiet', '-b', 'elsewhere-branch')
    const saved = process.env.GIT_DIR
    process.env.GIT_DIR = path.join(elsewhere, '.git')
    try {
      const status = await gitStatusTool({ root }).execute({}, context)
      expect(status.content).toContain('## main')
      expect(status.content).not.toContain('elsewhere-branch')
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})
