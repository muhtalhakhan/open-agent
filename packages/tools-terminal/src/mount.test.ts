import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry } from '@open-agent/agent'
import { createSessionWorkspace, type Workspace } from '@open-agent/tools-files'
import { mountTerminalTools } from './mount.js'

let base: string
let workspace: Workspace
const ctx = { taskId: 't1', signal: new AbortController().signal }
const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'mount-terminal-'))
  workspace = await createSessionWorkspace({ base })
})

afterEach(async () => {
  await workspace.dispose()
  await fs.rm(base, { recursive: true, force: true })
})

describe('mountTerminalTools', () => {
  it('registers the shell and process tools', () => {
    const registry = new ToolRegistry()
    mountTerminalTools(registry, workspace)
    expect(
      registry
        .list()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(['list_processes', 'read_process_output', 'run_command', 'start_process', 'stop_process'])
  })

  it('runs commands inside the session workspace', async () => {
    const registry = new ToolRegistry()
    mountTerminalTools(registry, workspace)
    await fs.writeFile(path.join(workspace.root, 'marker.txt'), '')

    const result = await registry.get('run_command')!.execute({ command: 'ls' }, ctx)

    expect(result.content).toContain('marker.txt')
  })

  it('kills a background process on dispose, so a session cannot leak a server', async () => {
    const registry = new ToolRegistry()
    const dispose = mountTerminalTools(registry, workspace)
    const started = await registry.get('start_process')!.execute({ command: 'sleep 30' }, ctx)
    const id = started.content.match(/proc_[0-9a-f]{8}/)![0]

    dispose()
    await settle()

    // The registry went with the mount, so the tools are gone too.
    expect(registry.list()).toEqual([])
    expect(id).toMatch(/^proc_/)
  })

  it('passes the command policy through to both tools', async () => {
    const registry = new ToolRegistry()
    mountTerminalTools(registry, workspace, { allowedCommands: ['echo'] })

    const ran = await registry.get('run_command')!.execute({ command: 'curl example.test' }, ctx)
    const started = await registry.get('start_process')!.execute({ command: 'curl example.test' }, ctx)

    expect(ran.error).toContain('not in the allowed command list')
    expect(started.error).toContain('not in the allowed command list')
  })

  it('gives each session its own process registry', async () => {
    const other = await createSessionWorkspace({ base })
    const first = new ToolRegistry()
    const second = new ToolRegistry()
    mountTerminalTools(first, workspace)
    mountTerminalTools(second, other)

    await first.get('start_process')!.execute({ command: 'sleep 5' }, ctx)
    const seen = await second.get('list_processes')!.execute({}, ctx)

    expect(seen.content).toBe('no background processes')
    await other.dispose()
  })
})
