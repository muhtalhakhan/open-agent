import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProcessRegistry } from './process-registry.js'
import {
  listProcessesTool,
  processTools,
  readProcessOutputTool,
  startProcessTool,
  stopProcessTool,
} from './process-tools.js'

let root: string
let registry: ProcessRegistry
const ctx = { taskId: 't1', signal: new AbortController().signal }
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

const start = (args: Record<string, unknown>, options: Record<string, unknown> = {}) =>
  startProcessTool({ root, registry, ...options }).execute(args as never, ctx)
const list = () => listProcessesTool({ registry }).execute({}, ctx)
const read = (args: Record<string, unknown>) => readProcessOutputTool({ registry }).execute(args as never, ctx)
const stop = (args: Record<string, unknown>) => stopProcessTool({ registry }).execute(args as never, ctx)

/** Pulls the `proc_xxxxxxxx` id out of what start_process told the model. */
const idFrom = (content: string) => content.match(/proc_[0-9a-f]{8}/)![0]

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'process-tools-'))
  registry = new ProcessRegistry()
})

afterEach(async () => {
  registry.disposeAll()
  await fs.rm(root, { recursive: true, force: true })
})

describe('permission levels', () => {
  it('asks before starting a process, because the command is the argument', () => {
    expect(startProcessTool({ root, registry }).permissionLevel).toBe('ask')
  })

  it.each([
    ['list_processes', listProcessesTool({ registry })],
    ['read_process_output', readProcessOutputTool({ registry })],
    // Stopping only ends something this agent started, and a model that needs
    // a prompt to clean up will simply leave servers running.
    ['stop_process', stopProcessTool({ registry })],
  ])('leaves %s safe', (_name, tool) => {
    expect(tool.permissionLevel).toBe('safe')
  })

  it('offers all four together sharing one registry', () => {
    expect(processTools({ root, registry }).map((tool) => tool.name)).toEqual([
      'start_process',
      'list_processes',
      'read_process_output',
      'stop_process',
    ])
  })
})

describe('startProcessTool', () => {
  it('returns an id and tells the model how to use it', async () => {
    const result = await start({ command: 'sleep 5' })
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/started proc_[0-9a-f]{8}: sleep 5/)
    expect(result.content).toContain('read_process_output')
  })

  it('starts in a subdirectory when given one', async () => {
    await fs.mkdir(path.join(root, 'sub'))
    const result = await start({ command: 'pwd', cwd: 'sub' })
    await settle()
    const output = await read({ id: idFrom(result.content) })
    expect(output.content.split('\n')[0]).toMatch(/\/sub$/)
  })

  it('refuses a cwd outside the workspace root', async () => {
    const result = await start({ command: 'true', cwd: '/etc' })
    expect(result.error).toContain('outside the workspace root')
  })

  it('refuses a destructive command, exactly as run_command does', async () => {
    expect((await start({ command: 'rm -rf /' })).error).toContain('recursive delete')
  })

  it('hides credential-looking variables from the process', async () => {
    const result = await start({ command: 'echo "key=$OPENAI_API_KEY end"' }, { env: { OPENAI_API_KEY: 'sk-live-1' } })
    await settle()
    const output = await read({ id: idFrom(result.content) })
    expect(output.content).not.toContain('sk-live-1')
  })

  it('reports the running limit rather than starting anyway', async () => {
    registry = new ProcessRegistry({ maxRunning: 1 })
    await start({ command: 'sleep 5' })
    expect((await start({ command: 'sleep 5' })).error).toContain('the limit is 1')
  })
})

describe('listProcessesTool', () => {
  it('says so when nothing is running', async () => {
    expect((await list()).content).toBe('no background processes')
  })

  it('shows the id, state and command', async () => {
    await start({ command: 'sleep 5' })
    const result = await list()
    expect(result.content).toMatch(/proc_[0-9a-f]{8}\trunning for \d+s/)
    expect(result.content).toContain('sleep 5')
  })

  it('reports an exited process with its code', async () => {
    await start({ command: 'exit 3' })
    await settle()
    expect((await list()).content).toContain('exited 3')
  })
})

describe('readProcessOutputTool', () => {
  it('returns the output with a cursor to read on from', async () => {
    const started = await start({ command: 'echo hello' })
    await settle()
    const result = await read({ id: idFrom(started.content) })
    expect(result.content).toContain('hello')
    expect(result.content).toMatch(/cursor 6/)
  })

  it('returns only what is new when given the cursor back', async () => {
    const started = await start({ command: 'echo first; sleep 0.3; echo second' })
    const id = idFrom(started.content)
    await settle()
    const first = await read({ id })
    const cursor = Number(first.content.match(/cursor (\d+)/)![1])
    await settle(400)

    const second = await read({ id, since: cursor })

    expect(second.content).toContain('second')
    expect(second.content).not.toContain('first')
  })

  it('says when there is no new output rather than returning nothing', async () => {
    const started = await start({ command: 'sleep 5' })
    expect((await read({ id: idFrom(started.content) })).content).toContain('(no new output)')
  })

  it('reports an unknown id', async () => {
    expect((await read({ id: 'proc_deadbeef' })).error).toBe('no such process: "proc_deadbeef"')
  })

  it('rejects a negative cursor', async () => {
    const started = await start({ command: 'sleep 5' })
    expect((await read({ id: idFrom(started.content), since: -1 })).error).toContain('non-negative')
  })

  it('warns when the buffer dropped output before the read', async () => {
    registry = new ProcessRegistry({ bufferBytes: 20 })
    const started = await start({ command: 'seq 1 200' })
    await settle(300)
    const result = await read({ id: idFrom(started.content) })
    expect(result.content).toMatch(/\d+ bytes were dropped/)
  })
})

describe('stopProcessTool', () => {
  it('stops a running process', async () => {
    const started = await start({ command: 'sleep 30' })
    const id = idFrom(started.content)
    expect((await stop({ id })).content).toBe(`sent SIGTERM to ${id}`)
    await settle()
    expect(registry.get(id)?.status).toBe('exited')
  })

  it('passes a chosen signal through', async () => {
    const started = await start({ command: 'sleep 30' })
    const id = idFrom(started.content)
    expect((await stop({ id, signal: 'SIGKILL' })).content).toBe(`sent SIGKILL to ${id}`)
  })

  it('reports an unknown id', async () => {
    expect((await stop({ id: 'proc_deadbeef' })).error).toBe('no such process: "proc_deadbeef"')
  })
})
