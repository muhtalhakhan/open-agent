import fs from 'node:fs/promises'
import type { ToolDefinition, ToolResult } from '@open-agent/agent'
import { WorkspaceError, resolveInWorkspace } from '@open-agent/tools-files'
import { execute } from './execute.js'
import { ShellPolicyError, checkCommand, filterEnv, type CommandPolicy } from './policy.js'

/** Long enough for an install or a test run, short enough that a hang is not the agent's new life. */
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
/** Per stream, so a chatty build cannot evict the conversation. */
const DEFAULT_MAX_OUTPUT_BYTES = 64_000

export interface RunCommandToolOptions extends CommandPolicy {
  /** Absolute path commands run under. `cwd` arguments resolve inside it. */
  root: string
  /** Wall-clock limit for one command (default 120000, max 600000). */
  timeoutMs?: number
  /** Output kept per stream (default 64000). */
  maxOutputBytes?: number
  /** Environment to hand the command (default `process.env`, credential-filtered). */
  env?: NodeJS.ProcessEnv
  /** Credential-looking variables to pass through anyway, e.g. `["GH_TOKEN"]`. */
  allowEnv?: readonly string[]
}

type RunCommandArgs = {
  command: string
  cwd?: string
  timeout_ms?: number
}

const SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The shell command to run.' },
    cwd: { type: 'string', description: 'Directory to run in, relative to the workspace root (default ".").' },
    timeout_ms: { type: 'number', description: 'Wall-clock limit in milliseconds (default 120000, max 600000).' },
  },
  required: ['command'],
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

function positiveInt(value: unknown, fallback: number, max: number, name: string): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new WorkspaceError(`${name} must be a positive integer`)
  }
  return Math.min(value, max)
}

/**
 * Builds the text the model reads. Empty streams are omitted rather than
 * shown as an empty heading — most commands write to one stream only, and a
 * result that is three-quarters section headers reads as though something
 * went wrong.
 */
function render(result: Awaited<ReturnType<typeof execute>>, timeoutMs: number): string {
  const parts: string[] = []

  if (result.timedOut) {
    parts.push(`[timed out after ${timeoutMs}ms and was killed]`)
  } else if (result.cancelled) {
    parts.push('[cancelled]')
  } else if (result.signal) {
    parts.push(`[killed by ${result.signal}]`)
  } else {
    parts.push(`exit code: ${result.code}`)
  }

  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`)
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`)
  if (!result.stdout.trim() && !result.stderr.trim()) parts.push('(no output)')
  if (result.truncated) parts.push('[output was truncated at the byte ceiling]')

  return parts.join('\n\n')
}

/**
 * Run a shell command in the workspace.
 *
 * `ask`, exactly as `docs/security-model.md` specifies for running a shell
 * command. Every call is a prompt, because the command is the argument: no
 * static permission level can tell `ls` from `rm`, and the one thing that
 * reliably can is a human reading it. The destructive-command rules in
 * `policy.ts` sit in front of that as an accident guard, not as containment —
 * real containment is #86's sandbox, which this tool has nothing of yet.
 */
export function runCommandTool(options: RunCommandToolOptions): ToolDefinition<RunCommandArgs> {
  const configuredTimeout = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return {
    name: 'run_command',
    description:
      'Run a shell command in the workspace and return its exit code, stdout and stderr. ' +
      'Runs to completion — do not use it for servers or anything else that does not exit on its own.',
    schema: SCHEMA,
    permissionLevel: 'ask',
    async execute(args, context) {
      let command: string
      let cwd: string
      let timeoutMs: number
      try {
        command = checkCommand(args.command, options)
        cwd = await resolveInWorkspace(options.root, args.cwd ?? '.')
        timeoutMs = positiveInt(args.timeout_ms, configuredTimeout, MAX_TIMEOUT_MS, 'timeout_ms')
      } catch (err) {
        if (err instanceof ShellPolicyError || err instanceof WorkspaceError) return fail(err.message)
        return fail(err instanceof Error ? err.message : String(err))
      }

      const shownCwd = args.cwd ?? '.'
      try {
        const stats = await fs.stat(cwd)
        if (!stats.isDirectory()) return fail(`"${shownCwd}" is not a directory`)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return fail(`no such directory: "${shownCwd}"`)
        return fail(err instanceof Error ? err.message : String(err))
      }

      // Filtered per call rather than once at construction, so a key added to
      // the environment after startup is still kept from the model.
      const { env } = filterEnv(options.env ?? process.env, options.allowEnv)

      try {
        const result = await execute({ command, cwd, env, timeoutMs, maxOutputBytes, signal: context.signal })

        // A non-zero exit is reported as a successful tool call. A failing test
        // run or a grep that found nothing is an answer the model needs to read
        // and reason about, not a tool error that throws the output away.
        return { ok: true, content: render(result, timeoutMs) }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return fail('no shell available to run the command')
        return fail(err instanceof Error ? err.message : String(err))
      }
    },
  }
}
