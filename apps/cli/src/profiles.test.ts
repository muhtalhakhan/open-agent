import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadProfile } from './profiles.js'

describe('loadProfile', () => {
  const mockProfileDir = path.join(os.tmpdir(), 'test-openagent-profiles')
  const originalHomedir = os.homedir

  beforeEach(() => {
    fs.mkdirSync(mockProfileDir, { recursive: true })
    fs.mkdirSync(path.join(mockProfileDir, '.openagent', 'profiles'), { recursive: true })
    // Mock homedir to use temp dir
    os.homedir = () => mockProfileDir
  })

  afterEach(() => {
    fs.rmSync(mockProfileDir, { recursive: true, force: true })
    os.homedir = originalHomedir
  })

  it('loads a profile by name from user directory', () => {
    const file = path.join(mockProfileDir, '.openagent', 'profiles', 'test.yaml')
    fs.writeFileSync(file, 'name: Test\nmodel: test-model\n')
    const result = loadProfile('test')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.profile.model).toBe('test-model')
  })

  it('returns error for missing profile', () => {
    const result = loadProfile('nonexistent')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('not found')
  })

  it('returns error for invalid YAML (missing model)', () => {
    const repoPath = path.resolve(process.cwd(), 'examples', 'profiles', 'bad.yaml')
    fs.mkdirSync(path.dirname(repoPath), { recursive: true })
    fs.writeFileSync(repoPath, 'name: Bad\n')
    const result = loadProfile(repoPath)
    expect(result.ok).toBe(false)
    fs.unlinkSync(repoPath)
  })
})
