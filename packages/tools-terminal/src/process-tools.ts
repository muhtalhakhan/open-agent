import fs from 'node:fs/promises'
import type { ToolDefinition, ToolResult } from '@open-agent/agent'
import { WorkspaceError, resolveInWorkspace } from '@open-agent/tools-files'
import { ProcessLimitError, type ProcessRegistry, type ProcessSnapshot } from './process-registry.js'
import { ShellPolicyError, checkCommand, filterEnv, type CommandPolicy } from './policy.js'

export interface ProcessToolsOptions extends CommandPolicy {
  /** Absolute path processes start under. `cwd` arguments resolve inside it. */
  root: string
  /** Where the started processes are held. Share one across the tools so they see each other's. */
  registry: ProcessRegistry
  /** Environment handed to the process (default `process.env`, credential-filtered). */
  env?: NodeJS.ProcessEnv
  /** Credential-looking variables to pass through anyway. */
  allowEnv?: readonly string[]
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

function describe(snapshot: ProcessSnapshot, now: number): string {
  const age = Math.round(((snapshot.endedAt ?? now) - snapshot.startedAt) / 1000)
  const state =
    snapshot.status === 'running'
      ? `running for ${age}s`
      : snapshot.exitSignal
        ? `killed by ${snapshot.exitSignal} after ${age}s`
        : `exited ${snapshot.exitCode} after ${age}s`
  return `${snapshot.id}\t${state}\t${snapshot.bufferedBytes} bytes buffered\t${snapshot.command}`
}

/**
 * Start a command and leave it running.
 *
 * `ask`, for the same reason `run_command` is: the command is the argument.
 * If anything this deserves the prompt more, since what it starts outlives
 * the tool call that started it.
 */
export function startProcessTool(options: ProcessToolsOptions): ToolDefinition<{ command: string; cwd?: string }> {
  return {
    name: 'start_process',
    description:
      'Start a long-running command (a dev server, a watcher) in the background and return its id. ' +
      'Use read_process_output to see what it has printed and stop_process to end it. ' +
      'For a command that finishes on its own, use run_command instead.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to start.' },
        cwd: { type: 'string', description: 'Directory to run in, relative to the workspace root (default ".").' },
      },
      required: ['command'],
    },
    permissionLevel: 'ask',
    async execute(args) {
      let command: string
      let cwd: string
      try {
        command = checkCommand(args.command, options)
        cwd = await resolveInWorkspace(options.root, args.cwd ?? '.')
      } catch (err) {
        if (err instanceof ShellPolicyError || err instanceof WorkspaceError) return fail(err.message)
        return fail(err instanceof Error ? err.message : String(err))
      }

      const shownCwd = args.cwd ?? '.'
      try {
        const stats = await fs.stat(cwd)
        if (!stats.isDirectory()) return fail(`"${shownCwd}" is not a directory`)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fail(`no such directory: "${shownCwd}"`)
        return fail(err instanceof Error ? err.message : String(err))
      }

      const { env } = filterEnv(options.env ?? process.env, options.allowEnv)
      try {
        const snapshot = options.registry.start({ command, cwd, env })
        return {
          ok: true,
          content:
            `started ${snapshot.id}: ${snapshot.command}\n\n` +
            `[it is running in the background. Read its output with read_process_output({ id: "${snapshot.id}" }) ` +
            `and stop it with stop_process({ id: "${snapshot.id}" }).]`,
        }
      } catch (err) {
        if (err instanceof ProcessLimitError) return fail(err.message)
        return fail(err instanceof Error ? err.message : String(err))
      }
    },
  }
}

/** `safe`: listing what the agent itself started changes nothing. */
export function listProcessesTool(
  options: Pick<ProcessToolsOptions, 'registry'>,
): ToolDefinition<Record<string, never>> {
  return {
    name: 'list_processes',
    description: 'List the background processes started in this session, running and recently exited.',
    schema: { type: 'object', properties: {} },
    permissionLevel: 'safe',
    async execute() {
      const all = options.registry.list()
      if (all.length === 0) return { ok: true, content: 'no background processes' }
      const now = Date.now()
      return { ok: true, content: all.map((snapshot) => describe(snapshot, now)).join('\n') }
    },
  }
}

/**
 * `safe`: reading buffered output is a read of something the agent produced.
 *
 * `since` makes polling a server cheap — pass back the cursor from the last
 * call and only new output comes back, instead of the whole log every time.
 */
export function readProcessOutputTool(
  options: Pick<ProcessToolsOptions, 'registry'>,
): ToolDefinition<{ id: string; since?: number }> {
  return {
    name: 'read_process_output',
    description:
      'Read what a background process has printed. Pass the cursor from a previous call as since ' +
      'to get only what is new. stdout and stderr are merged in the order they arrived.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The process id from start_process.' },
        since: { type: 'number', description: 'Cursor from a previous read; omit to read from the start.' },
      },
      required: ['id'],
    },
    permissionLevel: 'safe',
    async execute(args) {
      if (typeof args.id !== 'string' || args.id === '') return fail('id is required')
      if (args.since !== undefined && (typeof args.since !== 'number' || args.since < 0)) {
        return fail('since must be a non-negative number')
      }

      const snapshot = options.registry.get(args.id)
      const result = options.registry.read(args.id, args.since)
      if (!snapshot || !result) return fail(`no such process: "${args.id}"`)

      const notes: string[] = [`[${snapshot.status}; cursor ${result.cursor} — pass it back as since to read on]`]
      if (result.missed > 0) {
        notes.unshift(`[${result.missed} bytes were dropped before this read; the buffer keeps only the most recent]`)
      }
      const body = result.text.trimEnd()
      return { ok: true, content: body ? `${body}\n\n${notes.join('\n')}` : `(no new output)\n\n${notes.join('\n')}` }
    },
  }
}

/**
 * `safe`: it only stops something this agent started, and stopping reduces
 * what is running rather than adding to it. A model that cannot clean up
 * after itself without a prompt will simply leave servers running.
 */
export function stopProcessTool(
  options: Pick<ProcessToolsOptions, 'registry'>,
): ToolDefinition<{ id: string; signal?: string }> {
  return {
    name: 'stop_process',
    description: 'Stop a background process by id, along with anything it started.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The process id from start_process.' },
        signal: { type: 'string', description: 'Signal to send (default SIGTERM).' },
      },
      required: ['id'],
    },
    permissionLevel: 'safe',
    async execute(args) {
      if (typeof args.id !== 'string' || args.id === '') return fail('id is required')
      const signal = (args.signal ?? 'SIGTERM') as NodeJS.Signals
      if (!options.registry.stop(args.id, signal)) return fail(`no such process: "${args.id}"`)
      return { ok: true, content: `sent ${signal} to ${args.id}` }
    },
  }
}

/** Every process tool at once, sharing one registry. */
export function processTools(options: ProcessToolsOptions): ToolDefinition[] {
  return [
    startProcessTool(options) as ToolDefinition,
    listProcessesTool(options) as ToolDefinition,
    readProcessOutputTool(options) as ToolDefinition,
    stopProcessTool(options) as ToolDefinition,
  ]
}
