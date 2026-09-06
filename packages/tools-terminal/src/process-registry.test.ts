import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OutputBuffer, ProcessLimitError, ProcessRegistry } from './process-registry.js'

describe('OutputBuffer', () => {
  it('returns everything written', () => {
    const buffer = new OutputBuffer(1000)
    buffer.append(Buffer.from('hello '))
    buffer.append(Buffer.from('world'))
    expect(buffer.read()).toEqual({ text: 'hello world', cursor: 11, missed: 0 })
  })

  it('returns only what is new when given a cursor', () => {
    const buffer = new OutputBuffer(1000)
    buffer.append(Buffer.from('first\n'))
    const { cursor } = buffer.read()
    buffer.append(Buffer.from('second\n'))
    expect(buffer.read(cursor)).toEqual({ text: 'second\n', cursor: 13, missed: 0 })
  })

  it('reads nothing new when nothing was written since the cursor', () => {
    const buffer = new OutputBuffer(1000)
    buffer.append(Buffer.from('only'))
    const { cursor } = buffer.read()
    expect(buffer.read(cursor).text).toBe('')
  })

  it('drops the oldest bytes past the limit and keeps exactly the limit', () => {
    const buffer = new OutputBuffer(10)
    buffer.append(Buffer.from('0123456789'))
    buffer.append(Buffer.from('abcde'))
    expect(buffer.size).toBe(10)
    expect(buffer.read().text).toBe('56789abcde')
  })

  it('splits a chunk that straddles the limit rather than dropping it whole', () => {
    const buffer = new OutputBuffer(5)
    buffer.append(Buffer.from('abcdefgh'))
    expect(buffer.read().text).toBe('defgh')
  })

  it('tells a reader that fell behind exactly how much it missed', () => {
    const buffer = new OutputBuffer(5)
    buffer.append(Buffer.from('abcdefgh'))
    const { missed, text } = buffer.read(0)
    expect(missed).toBe(3)
    expect(text).toBe('defgh')
  })

  it('keeps the cursor counting the total stream, not the buffer', () => {
    const buffer = new OutputBuffer(5)
    buffer.append(Buffer.from('abcdefgh'))
    expect(buffer.read().cursor).toBe(8)
  })
})

describe('ProcessRegistry', () => {
  let root: string
  let registry: ProcessRegistry

  const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))
  const start = (command: string) => registry.start({ command, cwd: root, env: process.env })

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'proc-registry-'))
    registry = new ProcessRegistry()
  })

  afterEach(async () => {
    registry.disposeAll()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('starts a process and reports it as running', () => {
    const snapshot = start('sleep 5')
    expect(snapshot.status).toBe('running')
    expect(snapshot.id).toMatch(/^proc_[0-9a-f]{8}$/)
  })

  it('captures output that arrives after the call returned', async () => {
    const { id } = start('echo hello')
    await settle()
    expect(registry.read(id)?.text).toBe('hello\n')
  })

  it('merges stderr into stdout in arrival order', async () => {
    const { id } = start('echo out; echo err 1>&2')
    await settle()
    expect(registry.read(id)?.text.split('\n').filter(Boolean).sort()).toEqual(['err', 'out'])
  })

  it('records the exit code once the process ends', async () => {
    const { id } = start('exit 7')
    await settle()
    const snapshot = registry.get(id)
    expect(snapshot?.status).toBe('exited')
    expect(snapshot?.exitCode).toBe(7)
  })

  it('keeps the output of an exited process readable', async () => {
    const { id } = start('echo last words')
    await settle()
    expect(registry.get(id)?.status).toBe('exited')
    expect(registry.read(id)?.text).toBe('last words\n')
  })

  it('lists processes oldest first', async () => {
    const first = start('sleep 5')
    await settle(20)
    const second = start('sleep 5')
    expect(registry.list().map((entry) => entry.id)).toEqual([first.id, second.id])
  })

  it('stops a running process', async () => {
    const { id } = start('sleep 30')
    expect(registry.stop(id)).toBe(true)
    await settle()
    expect(registry.get(id)?.status).toBe('exited')
  })

  it('stops the whole process group, not just the shell', async () => {
    // The grandchild holds the pipe open; if only the shell were signalled the
    // process would stay in `running` here.
    const { id } = start('sleep 30 | cat')
    registry.stop(id)
    await settle(300)
    expect(registry.get(id)?.status).toBe('exited')
  })

  it('treats stopping an already-exited process as success', async () => {
    const { id } = start('true')
    await settle()
    expect(registry.stop(id)).toBe(true)
  })

  it('reports stopping an unknown id as a miss', () => {
    expect(registry.stop('proc_deadbeef')).toBe(false)
  })

  it('refuses to start more than the running limit', () => {
    registry = new ProcessRegistry({ maxRunning: 2 })
    start('sleep 5')
    start('sleep 5')
    expect(() => start('sleep 5')).toThrow(ProcessLimitError)
  })

  it('lets an exited process free up a slot', async () => {
    registry = new ProcessRegistry({ maxRunning: 1 })
    start('true')
    await settle()
    expect(() => start('sleep 5')).not.toThrow()
  })

  it('kills everything on disposeAll', async () => {
    const { id } = start('sleep 30')
    registry.disposeAll()
    await settle()
    expect(registry.get(id)).toBeUndefined()
  })

  it('reads nothing for an unknown id', () => {
    expect(registry.read('proc_deadbeef')).toBeUndefined()
  })
})
