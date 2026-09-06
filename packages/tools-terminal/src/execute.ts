import { spawn } from 'node:child_process'
import { noneSandbox, type Sandbox } from './sandbox.js'

/** How long the process gets to exit after SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 5_000

export interface ExecuteOptions {
  command: string
  cwd: string
  /** The writable root. A sandbox mounts this; without one it is unused. */
  workspaceRoot?: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  signal: AbortSignal
  /** Isolation to run under. Defaults to none, which is what the tests want. */
  sandbox?: Sandbox
  /** Whether the command may reach the network, when the sandbox can enforce it. */
  network?: boolean
}

export interface ExecuteResult {
  code: number | null
  /** Signal that ended the process, e.g. `SIGKILL` after a timeout. */
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  cancelled: boolean
}

/**
 * Accumulates output up to a ceiling while still draining the stream past it.
 *
 * Dropping the extra rather than unsubscribing matters: a child whose stdout
 * pipe fills and is never read blocks forever, so a command that prints more
 * than the ceiling would hang instead of being truncated.
 */
class CappedBuffer {
  private readonly chunks: Buffer[] = []
  private size = 0
  truncated = false

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.size >= this.limit) {
      this.truncated = true
      return
    }
    const room = this.limit - this.size
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room))
      this.size = this.limit
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.size += chunk.length
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/**
 * Runs one command to completion, or to whichever limit it hits first.
 *
 * The child is started in its own process group (`detached`) so that a
 * timeout can signal the whole group. Killing only the shell would leave
 * `sleep 100 | cat` running with its parent gone — the tool would report a
 * timeout while the work carried on in the background.
 */
export function execute(options: ExecuteOptions): Promise<ExecuteResult> {
  return new Promise((resolve, reject) => {
    const sandbox = options.sandbox ?? noneSandbox()
    const { file, args } = sandbox.wrap({
      command: options.command,
      cwd: options.cwd,
      workspaceRoot: options.workspaceRoot ?? options.cwd,
      network: options.network ?? false,
    })
    const detached = process.platform !== 'win32'

    let child
    try {
      child = spawn(file, args, { cwd: options.cwd, env: options.env, detached, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(err)
      return
    }

    const stdout = new CappedBuffer(options.maxOutputBytes)
    const stderr = new CappedBuffer(options.maxOutputBytes)
    let timedOut = false
    let cancelled = false
    let settled = false

    /**
     * Negative pid targets the process group. It can fail benignly — the
     * group is already gone by the time the timer fires — so the throw is
     * swallowed rather than turned into a failure of a command that already
     * finished.
     */
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch {
        // already exited
      }
    }

    let hardKill: NodeJS.Timeout | undefined
    const stop = () => {
      killGroup('SIGTERM')
      // A process ignoring SIGTERM (an interactive prompt waiting on input,
      // a trap handler) still has to go, or the tool never returns.
      hardKill = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      hardKill.unref()
    }

    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    timer.unref()

    const onAbort = () => {
      cancelled = true
      stop()
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    // A signal that was already aborted before we got here fires no event, so
    // the check is explicit. Without it, a task cancelled while the tool was
    // still resolving its arguments would spawn the command anyway and then
    // wait out the full timeout for it.
    if (options.signal.aborted) onAbort()

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    const cleanup = () => {
      clearTimeout(timer)
      if (hardKill) clearTimeout(hardKill)
      options.signal.removeEventListener('abort', onAbort)
    }

    child.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    })

    // `close` rather than `exit`: it fires once the stdio streams have been
    // drained, so the last of the output is in hand before the result is built.
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        code,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
        cancelled,
      })
    })
  })
}
