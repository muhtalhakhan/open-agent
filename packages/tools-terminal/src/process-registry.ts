import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { noneSandbox, type Sandbox } from './sandbox.js'

/** How long a process gets after SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 5_000
/** Output retained per process. Older bytes are dropped, and the drop is reported. */
const DEFAULT_BUFFER_BYTES = 256_000
/** Running at once. A model that has started ten servers has lost the plot, not found a use case. */
const DEFAULT_MAX_RUNNING = 10
/** Exited processes kept for their output before the oldest is forgotten. */
const MAX_RETAINED_EXITED = 20

export type ProcessStatus = 'running' | 'exited'

export interface ProcessSnapshot {
  id: string
  command: string
  cwd: string
  status: ProcessStatus
  startedAt: number
  endedAt?: number
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  /** Bytes of output currently held for reading. */
  bufferedBytes: number
}

/**
 * Output kept for a background process, oldest bytes dropped first.
 *
 * Reads are by cursor rather than "everything since last time" so a caller
 * can poll a long-running server without re-reading its whole log, and so two
 * readers do not consume each other's output. The cursor is a byte offset
 * into the total stream, which means a reader that fell behind the buffer can
 * be told exactly how much it missed instead of silently seeing a gap.
 */
export class OutputBuffer {
  private chunks: Buffer[] = []
  private buffered = 0
  /** Bytes ever written, including those since dropped. */
  private written = 0
  /** Bytes evicted from the front. */
  private evicted = 0

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.buffered
  }

  get cursor(): number {
    return this.written
  }

  append(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.buffered += chunk.length
    this.written += chunk.length

    while (this.buffered > this.limit && this.chunks.length > 0) {
      const oldest = this.chunks.shift()!
      // A chunk straddling the limit is split rather than dropped whole, so
      // the buffer holds exactly the most recent `limit` bytes.
      const overflow = this.buffered - this.limit
      if (oldest.length > overflow) {
        const kept = oldest.subarray(overflow)
        this.chunks.unshift(kept)
        this.buffered -= overflow
        this.evicted += overflow
        break
      }
      this.buffered -= oldest.length
      this.evicted += oldest.length
    }
  }

  /** Everything from `since` to now. `missed` counts bytes dropped before the caller got to them. */
  read(since = 0): { text: string; cursor: number; missed: number } {
    const start = Math.max(since, this.evicted)
    const missed = Math.max(0, this.evicted - since)
    const all = Buffer.concat(this.chunks)
    return { text: all.subarray(start - this.evicted).toString('utf8'), cursor: this.written, missed }
  }
}

interface Entry {
  snapshot: ProcessSnapshot
  child: ChildProcess
  output: OutputBuffer
  detached: boolean
}

export interface StartOptions {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** The writable root a sandbox mounts. Defaults to `cwd`. */
  workspaceRoot?: string
}

export class ProcessLimitError extends Error {
  override readonly name = 'ProcessLimitError'
}

/**
 * Long-running commands the agent started and can come back to.
 *
 * `run_command` waits for the process to exit, which is the right shape for a
 * build or a test run and useless for a dev server: the tool would sit there
 * until the timeout killed the very thing it was asked to start. This holds
 * those processes instead, so the model can start one, look at its output
 * later, and stop it when it is done.
 *
 * Processes are started in their own group, exactly as `run_command` does, so
 * stopping one takes its children with it.
 */
export class ProcessRegistry {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly options: {
      maxRunning?: number
      bufferBytes?: number
      sandbox?: Sandbox
      network?: boolean
    } = {},
    private readonly spawnFn: typeof spawn = spawn,
  ) {}

  private get maxRunning(): number {
    return this.options.maxRunning ?? DEFAULT_MAX_RUNNING
  }

  start(options: StartOptions): ProcessSnapshot {
    const running = [...this.entries.values()].filter((entry) => entry.snapshot.status === 'running')
    if (running.length >= this.maxRunning) {
      throw new ProcessLimitError(
        `${running.length} processes are already running (the limit is ${this.maxRunning}); stop one before starting another`,
      )
    }

    const detached = process.platform !== 'win32'
    const sandbox = this.options.sandbox ?? noneSandbox()
    const { file, args } = sandbox.wrap({
      command: options.command,
      cwd: options.cwd,
      workspaceRoot: options.workspaceRoot ?? options.cwd,
      network: this.options.network ?? false,
    })
    const child = this.spawnFn(file, args, {
      cwd: options.cwd,
      env: options.env,
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const id = `proc_${randomBytes(4).toString('hex')}`
    const output = new OutputBuffer(this.options.bufferBytes ?? DEFAULT_BUFFER_BYTES)
    const snapshot: ProcessSnapshot = {
      id,
      command: options.command,
      cwd: options.cwd,
      status: 'running',
      startedAt: Date.now(),
      exitCode: null,
      exitSignal: null,
      bufferedBytes: 0,
    }
    const entry: Entry = { snapshot, child, output, detached }
    this.entries.set(id, entry)

    // Merged in arrival order rather than kept apart. For a server the
    // interleaving is the information — a request log and the error it
    // produced belong next to each other, which is what a terminal shows.
    child.stdout?.on('data', (chunk: Buffer) => output.append(chunk))
    child.stderr?.on('data', (chunk: Buffer) => output.append(chunk))

    child.on('error', (err) => {
      output.append(Buffer.from(`\n[failed to start: ${err.message}]\n`))
      snapshot.status = 'exited'
      snapshot.endedAt = Date.now()
    })

    child.on('close', (code, signal) => {
      snapshot.status = 'exited'
      snapshot.endedAt = Date.now()
      snapshot.exitCode = code
      snapshot.exitSignal = signal
      this.prune()
    })

    return { ...snapshot }
  }

  get(id: string): ProcessSnapshot | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    return { ...entry.snapshot, bufferedBytes: entry.output.size }
  }

  list(): ProcessSnapshot[] {
    return [...this.entries.values()]
      .map((entry) => ({ ...entry.snapshot, bufferedBytes: entry.output.size }))
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  read(id: string, since = 0): { text: string; cursor: number; missed: number } | undefined {
    return this.entries.get(id)?.output.read(since)
  }

  /**
   * Signals the process group and reports whether there was anything to
   * signal. A process that has already exited is not an error — the caller
   * wanted it stopped, and it is stopped.
   */
  stop(id: string, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    if (entry.snapshot.status === 'exited') return true

    this.signal(entry, signal)
    const hard = setTimeout(() => {
      if (entry.snapshot.status === 'running') this.signal(entry, 'SIGKILL')
    }, KILL_GRACE_MS)
    hard.unref()
    return true
  }

  private signal(entry: Entry, signal: NodeJS.Signals): void {
    try {
      if (entry.detached && entry.child.pid !== undefined) process.kill(-entry.child.pid, signal)
      else entry.child.kill(signal)
    } catch {
      // already gone
    }
  }

  /** Kills everything still running. The CLI calls this on the way out. */
  disposeAll(): void {
    for (const [id, entry] of this.entries) {
      if (entry.snapshot.status === 'running') this.signal(entry, 'SIGKILL')
      this.entries.delete(id)
    }
  }

  /**
   * Exited processes are kept so their output can still be read, but not
   * forever — an agent that restarts a server twenty times should not carry
   * every previous attempt's log for the rest of the session.
   */
  private prune(): void {
    const exited = [...this.entries.entries()]
      .filter(([, entry]) => entry.snapshot.status === 'exited')
      .sort(([, a], [, b]) => (a.snapshot.endedAt ?? 0) - (b.snapshot.endedAt ?? 0))

    for (const [id] of exited.slice(0, Math.max(0, exited.length - MAX_RETAINED_EXITED))) {
      this.entries.delete(id)
    }
  }
}
