import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceError, isInside, resolveInWorkspace } from './workspace.js'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('isInside', () => {
  it('accepts the root itself and its descendants', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c/d.txt')).toBe(true)
  })

  it('rejects a sibling whose name merely starts the same way', () => {
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
  })
})

describe('resolveInWorkspace', () => {
  it('resolves a relative path against the root', async () => {
    await fs.writeFile(path.join(root, 'f.txt'), 'x')
    expect(await resolveInWorkspace(root, 'f.txt')).toBe(path.join(await fs.realpath(root), 'f.txt'))
  })

  it('accepts an absolute path inside the root', async () => {
    const file = path.join(await fs.realpath(root), 'f.txt')
    await fs.writeFile(file, 'x')
    expect(await resolveInWorkspace(root, file)).toBe(file)
  })

  it('returns a path that does not exist yet, so callers can report ENOENT themselves', async () => {
    expect(await resolveInWorkspace(root, 'missing.txt')).toBe(path.join(await fs.realpath(root), 'missing.txt'))
  })

  it('rejects traversal out of the root', async () => {
    await expect(resolveInWorkspace(root, '../elsewhere')).rejects.toThrow(WorkspaceError)
  })

  it('rejects an absolute path outside the root', async () => {
    await expect(resolveInWorkspace(root, '/etc/passwd')).rejects.toThrow('outside the workspace root')
  })

  it('rejects a symlink pointing out of the root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-outside-'))
    await fs.symlink(outside, path.join(root, 'escape'))
    try {
      await expect(resolveInWorkspace(root, 'escape')).rejects.toThrow('symlink')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('allows a symlink that stays inside the root', async () => {
    await fs.mkdir(path.join(root, 'real'))
    await fs.symlink(path.join(root, 'real'), path.join(root, 'link'))
    expect(await resolveInWorkspace(root, 'link')).toBe(path.join(await fs.realpath(root), 'real'))
  })

  it('rejects an empty or non-string path', async () => {
    await expect(resolveInWorkspace(root, '  ')).rejects.toThrow('path is required')
    await expect(resolveInWorkspace(root, 42)).rejects.toThrow('path is required')
  })
})
