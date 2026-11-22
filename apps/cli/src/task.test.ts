import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop, SessionLog, type LlmAdapter, type LlmRequest, type LlmResponse } from '@open-agent/agent'
import { ToolRegistry } from '@open-agent/agent'
import { executeTask } from './task.js'
import * as toolsSkills from '@open-agent/tools-skills'

class RecordingEchoAdapter implements LlmAdapter {
  name = 'recording-echo'
  requests: LlmRequest[] = []
  async generate(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request)
    return { message: { role: 'assistant', content: 'done' } }
  }
}

describe('executeTask — skills integration', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'task-skills-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('injects matched skill names into system message context', async () => {
    const fakeSkill: toolsSkills.LoadedSkill = {
      id: 'release-repo',
      file: {
        skillVersion: 1,
        name: 'Release Repo',
        description: 'How to release to npm',
        tags: ['release', 'npm'],
        steps: [{ action: 'npm version patch' }],
        createdAt: '',
        updatedAt: '',
      },
    }

    vi.spyOn(toolsSkills, 'loadUserSkills').mockResolvedValue([fakeSkill])

    const sessions = new SessionLog()
    const llm = new RecordingEchoAdapter()
    const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm })

    await executeTask(loop, sessions, 'How do I release this package?', new AbortController().signal)

    expect(llm.requests.length).toBeGreaterThan(0)
    const system = llm.requests[0].messages.find((m) => m.role === 'system')
    expect(system).toBeDefined()
    expect(system?.content).toContain('release-repo')
    expect(system?.content).toContain('How to release to npm')
    expect(system?.content).toContain('read_skill')
    // Invariant: steps themselves are NOT in the context, only names and descriptions
    expect(system?.content).not.toContain('npm version patch')
  })

  it('does not inject skills context when skills: false', async () => {
    const fakeSkill: toolsSkills.LoadedSkill = {
      id: 'release-repo',
      file: {
        skillVersion: 1,
        name: 'Release Repo',
        description: 'How to release to npm',
        tags: ['release'],
        steps: [{ action: 'bump' }],
        createdAt: '',
        updatedAt: '',
      },
    }

    vi.spyOn(toolsSkills, 'loadUserSkills').mockResolvedValue([fakeSkill])

    const sessions = new SessionLog()
    const llm = new RecordingEchoAdapter()
    const loop = new AgentLoop({ sessions, tools: new ToolRegistry(), llm })

    await executeTask(loop, sessions, 'release this', new AbortController().signal, { skills: false })

    expect(llm.requests.length).toBeGreaterThan(0)
    const system = llm.requests[0].messages.find((m) => m.role === 'system')
    expect(system?.content).toBeUndefined()
  })
})
