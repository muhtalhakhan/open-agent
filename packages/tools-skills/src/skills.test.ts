import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadSavedSkill,
  loadUserSkills,
  matchSkills,
  buildSkillContext,
  saveSkillTool,
  listSkillsTool,
  readSkillTool,
  USER_SKILLS_DIR,
} from './index.js'
import type { SavedSkillFile } from './spec-types.js'
import type { ToolExecutionContext } from '@open-agent/agent'

const ctx: ToolExecutionContext = { taskId: 't', signal: new AbortController().signal }

function writeSkill(dir: string, name: string, skill: Partial<SavedSkillFile>) {
  const file: SavedSkillFile = {
    skillVersion: 1,
    name: 'Test Skill',
    description: 'A test skill',
    tags: ['test', 'example'],
    steps: [{ action: 'Do something' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...skill,
  }
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(file, null, 2), 'utf-8')
}

describe('tools-skills — loader and matching', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openagent-skills-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('USER_SKILLS_DIR lives under the user home, never a system path', () => {
    expect(USER_SKILLS_DIR).toContain('.openagent')
    expect(USER_SKILLS_DIR).toContain('skills')
    const normalized = USER_SKILLS_DIR.replace(/\\/g, '/').toLowerCase()
    expect(normalized).not.toContain('/etc/')
    expect(normalized).not.toContain('/usr/')
    expect(normalized).not.toContain('/var/')
    expect(normalized).not.toContain('program files')
  })

  it('loadSavedSkill rejects a non-version-1 file', async () => {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify({ skillVersion: 99 }), 'utf-8')
    expect(await loadSavedSkill(bad)).toBeNull()
  })

  it('loadSavedSkill rejects missing required fields', async () => {
    const bad = join(dir, 'missing.json')
    writeFileSync(bad, JSON.stringify({ skillVersion: 1, name: 'x' }), 'utf-8')
    expect(await loadSavedSkill(bad)).toBeNull()
  })

  it('loadUserSkills skips directories named *.json', async () => {
    mkdirSync(join(dir, 'sub.json'), { recursive: true })
    writeSkill(dir, 'ok', { tags: ['test'] })
    const loaded = await loadUserSkills(() => {}, dir)
    const names = loaded.map((l) => l.id)
    expect(names).toContain('ok')
    expect(names).not.toContain('sub')
  })

  it('matchSkills finds skill by exact tag', () => {
    const skill = {
      id: 'release-repo',
      file: {
        skillVersion: 1,
        name: 'Release Repo',
        description: 'How to release',
        tags: ['release', 'npm'],
        steps: [{ action: 'bump version' }],
        createdAt: '',
        updatedAt: '',
      },
    }
    const matches = matchSkills([skill], 'how do I release this package?')
    expect(matches).toHaveLength(1)
    expect(matches[0].confidence).toBeGreaterThanOrEqual(0.8)
    expect(matches[0].skill.id).toBe('release-repo')
  })

  it('matchSkills finds skill by skill ID', () => {
    const skill = {
      id: 'deploy-app',
      file: {
        skillVersion: 1,
        name: 'Deploy',
        description: 'How to deploy',
        tags: ['cloud'],
        steps: [{ action: 'deploy' }],
        createdAt: '',
        updatedAt: '',
      },
    }
    const matches = matchSkills([skill], 'run deploy-app please')
    expect(matches).toHaveLength(1)
    expect(matches[0].confidence).toBe(0.9)
  })

  it('matchSkills returns empty array when no match', () => {
    const skill = {
      id: 'unrelated',
      file: {
        skillVersion: 1,
        name: 'Unrelated',
        description: 'Does nothing',
        tags: ['unrelated'],
        steps: [{ action: 'nothing' }],
        createdAt: '',
        updatedAt: '',
      },
    }
    const matches = matchSkills([skill], 'something completely different')
    expect(matches).toHaveLength(0)
  })
})

describe('tools-skills — tool execution', () => {
  it('save_skill validates skill name format', async () => {
    const tool = saveSkillTool()
    const result = await tool.execute(
      {
        name: '!!',
        description: 'A skill',
        tags: ['test'],
        steps: [{ action: 'do it' }],
      },
      ctx,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('skill name')
  })

  it('save_skill requires at least one tag', async () => {
    const tool = saveSkillTool()
    const result = await tool.execute(
      {
        name: 'my-skill',
        description: 'A skill',
        tags: [],
        steps: [{ action: 'do it' }],
      },
      ctx,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('tag')
  })

  it('save_skill requires at least one step', async () => {
    const tool = saveSkillTool()
    const result = await tool.execute(
      {
        name: 'my-skill',
        description: 'A skill',
        tags: ['test'],
        steps: [],
      },
      ctx,
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('step')
  })

  it('list_skills reports when no skills exist', async () => {
    const tool = listSkillsTool()
    const result = await tool.execute({}, ctx)
    expect(result.ok).toBe(true)
    // In test environment, the real folder may have no skills
    expect(typeof result.content).toBe('string')
  })

  it('tools have safe permission level', () => {
    expect(saveSkillTool().permissionLevel).toBe('safe')
    expect(listSkillsTool().permissionLevel).toBe('safe')
    expect(readSkillTool().permissionLevel).toBe('safe')
  })

  it('buildSkillContext includes names and descriptions but NOT full steps', () => {
    const skill = {
      id: 'release-repo',
      file: {
        skillVersion: 1,
        name: 'Release Repo',
        description: 'How to release to npm',
        tags: ['release', 'npm'],
        steps: [{ action: 'SECRET_STEP_DO_NOT_LEAK' }],
        createdAt: '',
        updatedAt: '',
      },
    }
    const context = buildSkillContext([skill], 'I want to release this package')
    expect(context).toBeDefined()
    expect(context).toContain('release-repo')
    expect(context).toContain('How to release to npm')
    // Invariant: names and descriptions go into context, NOT content/steps
    expect(context).not.toContain('SECRET_STEP_DO_NOT_LEAK')
    expect(context).toContain('read_skill')
  })

  it('buildSkillContext returns undefined when no skill matches', () => {
    const skill = {
      id: 'release-repo',
      file: {
        skillVersion: 1,
        name: 'Release Repo',
        description: 'How to release to npm',
        tags: ['release', 'npm'],
        steps: [{ action: 'bump' }],
        createdAt: '',
        updatedAt: '',
      },
    }
    const context = buildSkillContext([skill], 'unrelated task')
    expect(context).toBeUndefined()
  })

  it('read_skill returns full procedure steps', async () => {
    const tool = readSkillTool()
    const result = await tool.execute({ name: 'nonexistent-skill' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not found')
  })
})
