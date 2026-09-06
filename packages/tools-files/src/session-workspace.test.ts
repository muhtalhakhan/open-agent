import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry } from '@open-agent/agent'
import { mountFileTools } from './mount.js'
import { createSessionWorkspace, openWorkspace } from './session-workspace.js'

let base: string

const exists = async (target: string) => {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-base-'))
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe('openWorkspace', () => {
  it('wraps an existing directory and resolves it', async () => {
    const workspace = await openWorkspace({ root: base })
    expect(workspace.root).toBe(await fs.realpath(base))
    expect(workspace.id).toMatch(/^ws_[0-9a-f]{8}$/)
  })

  it('carries the policy it was given', async () => {
    const workspace = await openWorkspace({ root: base, policy: { readOnly: true } })
    expect(workspace.policy).toEqual({ readOnly: true })
  })

  it('takes an explicit id, so a session can be named', async () => {
    expect((await openWorkspace({ root: base, id: 'session-7' })).id).toBe('session-7')
  })

  it('never deletes the directory it did not create', async () => {
    const workspace = await openWorkspace({ root: base })
    await workspace.dispose()
    expect(await exists(base)).toBe(true)
  })

  it('refuses a root that is a file', async () => {
    const file = path.join(base, 'notes.txt')
    await fs.writeFile(file, '')
    await expect(openWorkspace({ root: file })).rejects.toThrow('is not a directory')
  })

  it('refuses a root that does not exist', async () => {
    await expect(openWorkspace({ root: path.join(base, 'nope') })).rejects.toThrow()
  })
})

describe('createSessionWorkspace', () => {
  it('provisions a fresh directory under the base', async () => {
    const workspace = await createSessionWorkspace({ base })
    expect(workspace.root.startsWith(await fs.realpath(base))).toBe(true)
    expect(await exists(workspace.root)).toBe(true)
    await workspace.dispose()
  })

  it('names the directory after the session id', async () => {
    const workspace = await createSessionWorkspace({ base, id: 'session-7' })
    expect(path.basename(workspace.root)).toBe('session-7')
    await workspace.dispose()
  })

  it('keeps two concurrent sessions apart', async () => {
    const first = await createSessionWorkspace({ base })
    const second = await createSessionWorkspace({ base })

    expect(first.root).not.toBe(second.root)
    await fs.writeFile(path.join(first.root, 'mine.txt'), 'first')
    expect(await fs.readdir(second.root)).toEqual([])

    await first.dispose()
    await second.dispose()
  })

  it('deletes the directory it created on dispose', async () => {
    const workspace = await createSessionWorkspace({ base })
    await fs.writeFile(path.join(workspace.root, 'scratch.txt'), 'x')
    await workspace.dispose()
    expect(await exists(workspace.root)).toBe(false)
  })

  it('keeps the directory when cleanup is off, for inspecting the aftermath', async () => {
    const workspace = await createSessionWorkspace({ base, cleanup: false })
    await workspace.dispose()
    expect(await exists(workspace.root)).toBe(true)
  })

  it('re-entering a session by id finds its directory rather than failing', async () => {
    const first = await createSessionWorkspace({ base, id: 'session-7', cleanup: false })
    await fs.writeFile(path.join(first.root, 'earlier.txt'), 'x')

    const again = await createSessionWorkspace({ base, id: 'session-7' })

    expect(await fs.readdir(again.root)).toEqual(['earlier.txt'])
    await again.dispose()
  })

  it.each(['../escape', 'a/b', '.', '..'])('refuses %s as an id, which would land outside the base', async (id) => {
    await expect(createSessionWorkspace({ base, id })).rejects.toThrow('single path segment')
  })

  it('disposing twice is not an error', async () => {
    const workspace = await createSessionWorkspace({ base })
    await workspace.dispose()
    await expect(workspace.dispose()).resolves.toBeUndefined()
  })
})

describe('mountFileTools', () => {
  it('registers all four tools against one workspace', async () => {
    const registry = new ToolRegistry()
    const workspace = await openWorkspace({ root: base })

    mountFileTools(registry, workspace)

    expect(
      registry
        .list()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['list_directory', 'read_file', 'search_files', 'write_file'])
  })

  it('gives every tool the same policy, so none can disagree with another', async () => {
    const registry = new ToolRegistry()
    const workspace = await openWorkspace({ root: base, policy: { deny: ['internal/**'] } })
    await fs.mkdir(path.join(base, 'internal'))
    await fs.writeFile(path.join(base, 'internal', 'secret.txt'), 'needle')
    mountFileTools(registry, workspace)
    const ctx = { taskId: 't1', signal: new AbortController().signal }

    const read = await registry.get('read_file')!.execute({ path: 'internal/secret.txt' }, ctx)
    const found = await registry.get('search_files')!.execute({ query: 'needle' }, ctx)

    expect(read.error).toContain('file policy')
    expect(found.content).toContain('no matches')
  })

  it('unregisters everything it registered', async () => {
    const registry = new ToolRegistry()
    const dispose = mountFileTools(registry, await openWorkspace({ root: base }))
    dispose()
    expect(registry.list()).toEqual([])
  })
})
