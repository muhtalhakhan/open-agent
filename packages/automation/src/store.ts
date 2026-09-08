import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ScheduledTask, TaskStore } from './types.js'

/** Where the schedule lives when no path is given. */
const DEFAULT_SCHEDULE_FILE = path.join(os.tmpdir(), '.open-agent', 'schedule.json')

/** Keeps the schedule in process memory. The default, and what tests use. */
export class MemoryTaskStore implements TaskStore {
  private tasks: ScheduledTask[] = []

  async load(): Promise<ScheduledTask[]> {
    return this.tasks.map((t) => ({ ...t }))
  }

  async save(tasks: ScheduledTask[]): Promise<void> {
    this.tasks = tasks.map((t) => ({ ...t }))
  }
}

/**
 * Persists the whole schedule to one JSON file.
 *
 * The schedule is small and always read and written in full, so a single file
 * is enough — and writing it through a temp file plus `rename` means a crash
 * mid-write leaves the previous schedule intact rather than a truncated one.
 * Saves are serialized on a promise chain so two overlapping mutations cannot
 * interleave their writes.
 */
export class FileTaskStore implements TaskStore {
  private readonly file: string
  private queue: Promise<void> = Promise.resolve()

  constructor(file: string = DEFAULT_SCHEDULE_FILE) {
    this.file = path.resolve(file)
  }

  async load(): Promise<ScheduledTask[]> {
    try {
      const content = await fs.readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(content)
      return Array.isArray(parsed) ? (parsed as ScheduledTask[]) : []
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return []
      throw err
    }
  }

  async save(tasks: ScheduledTask[]): Promise<void> {
    const write = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf8')
      await fs.rename(tmp, this.file)
    })
    // Keep the chain alive even when this write fails, so one bad save does
    // not reject every save queued behind it.
    this.queue = write.catch(() => {})
    return write
  }

  /** The file this store reads and writes. */
  getFile(): string {
    return this.file
  }
}
