import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileTaskStore, MemoryTaskStore } from './store.js'
import type { ScheduledTask } from './types.js'

const dirs: string[] = []

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-agent-schedule-'))
  dirs.push(dir)
  return path.join(dir, 'nested', 'schedule.json')
}

const task = (id: string): ScheduledTask => ({
  id,
  name: id,
  prompt: 'p',
  trigger: { kind: 'at', at: 1_000 },
  status: 'pending',
  createdAt: 0,
  nextRunAt: 1_000,
  runCount: 0,
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('MemoryTaskStore', () => {
  it('copies on the way in and out, so callers cannot mutate stored state', async () => {
    const store = new MemoryTaskStore()
    const original = task('a')
    await store.save([original])
    original.name = 'mutated'

    const loaded = await store.load()
    expect(loaded[0].name).toBe('a')
    loaded[0].name = 'also mutated'
    expect((await store.load())[0].name).toBe('a')
  })
})

describe('FileTaskStore', () => {
  it('returns an empty schedule when the file does not exist yet', async () => {
    const store = new FileTaskStore(await tempFile())
    expect(await store.load()).toEqual([])
  })

  it('round-trips the schedule, creating the directory it needs', async () => {
    const store = new FileTaskStore(await tempFile())
    await store.save([task('a'), task('b')])
    expect((await store.load()).map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('leaves no partial file behind when overlapping saves race', async () => {
    const store = new FileTaskStore(await tempFile())
    await Promise.all([store.save([task('a')]), store.save([task('a'), task('b')]), store.save([task('c')])])

    const loaded = await store.load()
    expect(loaded.map((t) => t.id)).toEqual(['c'])
  })

  it('surfaces a save failure without wedging later saves', async () => {
    const file = await tempFile()
    const store = new FileTaskStore(file)
    // A directory where the temp file wants to go makes exactly one write fail.
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.mkdir(`${file}.tmp`)

    await expect(store.save([task('a')])).rejects.toThrow()

    await fs.rmdir(`${file}.tmp`)
    await store.save([task('b')])
    expect((await store.load()).map((t) => t.id)).toEqual(['b'])
  })
})
