import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_INSTRUCTIONS_BYTES, buildSystemPrompt, findRepoRoot, loadProjectInstructions } from './instructions.js'

let root: string

/** A throwaway repo: a temp dir with a `.git` marker, plus whatever files a test writes. */
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'open-agent-instructions-'))
  await mkdir(path.join(root, '.git'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('findRepoRoot', () => {
  it('finds the root from a nested directory', async () => {
    const nested = path.join(root, 'packages', 'agent', 'src')
    await mkdir(nested, { recursive: true })

    expect(await findRepoRoot(nested)).toBe(root)
  })

  it('treats a `.git` file as a root, so worktrees and submodules work', async () => {
    const wt = await mkdtemp(path.join(tmpdir(), 'open-agent-worktree-'))
    await writeFile(path.join(wt, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt')

    expect(await findRepoRoot(wt)).toBe(wt)
    await rm(wt, { recursive: true, force: true })
  })

  it('returns null rather than guessing when there is no repo', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'open-agent-norepo-'))

    expect(await findRepoRoot(bare)).toBeNull()
    await rm(bare, { recursive: true, force: true })
  })
})

describe('loadProjectInstructions', () => {
  it('loads AGENTS.md from the repo root', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), '# Conventions\n\nUse tabs.')

    const loaded = await loadProjectInstructions({ cwd: root })

    expect(loaded?.text).toBe('# Conventions\n\nUse tabs.')
    expect(loaded?.source).toBe(path.join(root, 'AGENTS.md'))
    expect(loaded?.root).toBe(root)
    expect(loaded?.truncated).toBe(false)
  })

  it('loads from the repo root regardless of which subdirectory it starts in', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'root rules')
    const nested = path.join(root, 'packages', 'agent')
    await mkdir(nested, { recursive: true })

    const loaded = await loadProjectInstructions({ cwd: nested })

    expect(loaded?.text).toBe('root rules')
  })

  it('ignores a nested AGENTS.md — discovery is root-anchored', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'root rules')
    const nested = path.join(root, 'packages')
    await mkdir(nested, { recursive: true })
    await writeFile(path.join(nested, 'AGENTS.md'), 'nested rules')

    const loaded = await loadProjectInstructions({ cwd: nested })

    expect(loaded?.text).toBe('root rules')
  })

  it('prefers .openagent/instructions.md over AGENTS.md', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'shared rules')
    await mkdir(path.join(root, '.openagent'))
    await writeFile(path.join(root, '.openagent', 'instructions.md'), 'openagent rules')

    const loaded = await loadProjectInstructions({ cwd: root })

    expect(loaded?.text).toBe('openagent rules')
  })

  it('does not concatenate the two files', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'shared rules')
    await mkdir(path.join(root, '.openagent'))
    await writeFile(path.join(root, '.openagent', 'instructions.md'), 'openagent rules')

    const loaded = await loadProjectInstructions({ cwd: root })

    expect(loaded?.text).not.toContain('shared rules')
  })

  it('returns null when there is no instructions file', async () => {
    expect(await loadProjectInstructions({ cwd: root })).toBeNull()
  })

  it('returns null outside a repo', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'open-agent-norepo-'))
    await writeFile(path.join(bare, 'AGENTS.md'), 'orphan rules')

    expect(await loadProjectInstructions({ cwd: bare })).toBeNull()
    await rm(bare, { recursive: true, force: true })
  })

  it('treats a whitespace-only file as absent, so it cannot inject a blank system message', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), '   \n\n\t\n')

    expect(await loadProjectInstructions({ cwd: root })).toBeNull()
  })

  it('truncates a file past the byte cap and says so', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(100))

    const loaded = await loadProjectInstructions({ cwd: root, maxBytes: 50 })

    expect(loaded?.truncated).toBe(true)
    expect(loaded?.text).toContain('[instructions truncated]')
    expect(loaded?.text.startsWith('x'.repeat(50))).toBe(true)
  })

  it('leaves a file at exactly the cap untouched', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(50))

    const loaded = await loadProjectInstructions({ cwd: root, maxBytes: 50 })

    expect(loaded?.truncated).toBe(false)
    expect(loaded?.text).toBe('x'.repeat(50))
  })

  it('defaults to a cap generous enough for a real conventions file', async () => {
    await writeFile(path.join(root, 'AGENTS.md'), 'y'.repeat(8_000))

    const loaded = await loadProjectInstructions({ cwd: root })

    expect(MAX_INSTRUCTIONS_BYTES).toBeGreaterThan(8_000)
    expect(loaded?.truncated).toBe(false)
  })
})

describe('buildSystemPrompt', () => {
  it('names the source file and subordinates conventions to the live user', () => {
    const prompt = buildSystemPrompt({
      text: 'Use tabs.',
      source: '/repo/AGENTS.md',
      root: '/repo',
      truncated: false,
    })

    expect(prompt).toContain('AGENTS.md')
    expect(prompt).not.toContain('/repo/') // basename only — no local paths leaked to the model
    expect(prompt).toContain('a live instruction from the user wins')
    expect(prompt).toContain('Use tabs.')
  })
})
