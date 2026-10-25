import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolHooks, ToolResult } from '@open-agent/agent'

export const HOOK_EVENTS = ['pre_tool_call', 'post_tool_call', 'session_start', 'session_stop'] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

export interface HookDefinition {
  event: HookEvent
  /** A shell command, run with `sh -c` (or `cmd` on Windows). */
  command: string
  /** For the tool events: tool names it applies to, `*` ending a prefix (`browser_*`). Every tool when absent. */
  tools?: string[]
  timeoutMs: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 120_000
/** What a hook is told of a result: enough to act on, not a whole file. */
const RESULT_CHARS = 10_000
/** What is kept of a hook's own output for a reason or a notice. */
const OUTPUT_CHARS = 2_000
/** Exit code that blocks a call, as in other agents' hooks: anything else non-zero is a failure. */
const BLOCK_EXIT = 2

export type HooksResult = { ok: true; hooks: HookDefinition[] } | { ok: false; error: string }

const isInside = (dir: string, target: string) => {
  const relative = path.relative(dir, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Reads the person's hooks file. A missing file is no hooks; a file that is
 * there but wrong stops startup, since a guard hook that silently failed to
 * load is worse than no agent.
 *
 * Hooks run the person's commands with their privileges, so where they may
 * come from is narrow. Not the repository and not a profile: either would let
 * cloning a project, or importing a profile someone shared, run their
 * commands on this machine. And not from inside a workspace the agent can
 * write to, where it could give itself a hook.
 */
export function loadHooks(file: string, workspaceRoots: string[]): HooksResult {
  let content: string
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, hooks: [] }
    return { ok: false, error: `Can't read hooks file ${file}: ${err instanceof Error ? err.message : String(err)}` }
  }
  const real = fs.realpathSync(file)
  const writable = workspaceRoots.find((root) => fs.existsSync(root) && isInside(fs.realpathSync(root), real))
  if (writable) {
    return {
      ok: false,
      error: `Hooks file ${real} is inside the agent's workspace (${writable}), where the agent could edit it. Move it out, or point OPEN_AGENT_HOOKS_FILE elsewhere.`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    return {
      ok: false,
      error: `Hooks file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  const list = (parsed as { hooks?: unknown } | null)?.hooks
  if (!Array.isArray(list)) return { ok: false, error: `Hooks file ${file} needs a "hooks" list.` }

  const hooks: HookDefinition[] = []
  for (const [index, entry] of list.entries()) {
    const where = `Hooks file ${file}, hook ${index + 1}`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `${where} must be an object.` }
    }
    const { event, command, tools, timeout_ms: timeout, ...rest } = entry as Record<string, unknown>
    if (Object.keys(rest).length > 0) {
      return { ok: false, error: `${where} has unsupported fields: ${Object.keys(rest).join(', ')}.` }
    }
    if (!(HOOK_EVENTS as readonly unknown[]).includes(event)) {
      return { ok: false, error: `${where}: "event" must be one of ${HOOK_EVENTS.join(', ')}.` }
    }
    if (typeof command !== 'string' || !command.trim()) return { ok: false, error: `${where} needs a "command".` }
    if (tools !== undefined) {
      if (event !== 'pre_tool_call' && event !== 'post_tool_call') {
        return { ok: false, error: `${where}: "tools" only applies to pre_tool_call and post_tool_call.` }
      }
      if (!Array.isArray(tools) || !tools.every((name) => typeof name === 'string' && name.trim())) {
        return { ok: false, error: `${where}: "tools" must be a list of tool names.` }
      }
    }
    if (
      timeout !== undefined &&
      (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS)
    ) {
      return { ok: false, error: `${where}: "timeout_ms" must be a whole number from 1 to ${MAX_TIMEOUT_MS}.` }
    }
    hooks.push({
      event: event as HookEvent,
      command: command.trim(),
      ...(tools ? { tools: tools as string[] } : {}),
      timeoutMs: (timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS,
    })
  }
  return { ok: true, hooks }
}

function appliesTo(hook: HookDefinition, tool: string): boolean {
  if (!hook.tools) return true
  return hook.tools.some((name) => (name.endsWith('*') ? tool.startsWith(name.slice(0, -1)) : name === tool))
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

interface HookOutcome {
  /** The exit code, or `null` when it never exited on its own: killed on timeout, or failed to start. */
  code: number | null
  stdout: string
  stderr: string
  /** Why it never exited on its own. */
  problem?: string
}

export interface HookRunnerOptions {
  hooks: HookDefinition[]
  cwd: string
  /** The environment the CLI was started from, before `.env` added the agent's own keys to it. */
  env: NodeJS.ProcessEnv
  /** Where a failed observing hook is reported: it never stops the agent. */
  notice: (text: string) => void
}

/** Runs one hook with its payload as JSON on stdin. Never throws. */
function runHook(hook: HookDefinition, payload: Record<string, unknown>, options: HookRunnerOptions) {
  return new Promise<HookOutcome>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (outcome: HookOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...outcome, stdout: clip(stdout.trim(), OUTPUT_CHARS), stderr: clip(stderr.trim(), OUTPUT_CHARS) })
    }
    const child = spawn(hook.command, {
      shell: true,
      cwd: options.cwd,
      env: { ...options.env, OPEN_AGENT_HOOK_EVENT: hook.event },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({ code: null, stdout, stderr, problem: `timed out after ${hook.timeoutMs} ms` })
    }, hook.timeoutMs)
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (err) => done({ code: null, stdout, stderr, problem: err.message }))
    child.on('close', (code) => done({ code, stdout, stderr }))
    // A hook that ignores its input closes stdin early; that is its business.
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ event: hook.event, ...payload }))
  })
}

const explain = (hook: HookDefinition, outcome: HookOutcome) =>
  `${outcome.problem ?? `exited with ${outcome.code}`}${outcome.stderr ? `: ${outcome.stderr}` : ''} (hook: ${hook.command})`

function resultPayload(result: ToolResult) {
  return {
    ok: result.ok,
    content: clip(result.content, RESULT_CHARS),
    ...(result.error !== undefined ? { error: clip(result.error, RESULT_CHARS) } : {}),
  }
}

/**
 * The tool hooks for the registry, and a way to run the session hooks.
 *
 * A `pre_tool_call` hook is policy, so it fails closed: exit 0 lets the call
 * go on to approval, exit 2 blocks it with the hook's stderr as the reason,
 * and anything else — a crash, a timeout, a typo in the command — blocks it
 * too, because a guard that broke is not a guard that said yes. The other
 * events only observe, and a failure there is reported and otherwise ignored.
 */
export function createHookRunner(options: HookRunnerOptions): {
  toolHooks: ToolHooks
  session(event: 'session_start' | 'session_stop', payload: Record<string, unknown>): Promise<void>
} {
  const forEvent = (event: HookEvent) => options.hooks.filter((hook) => hook.event === event)
  const observe = async (hooks: HookDefinition[], payload: Record<string, unknown>) => {
    for (const hook of hooks) {
      const outcome = await runHook(hook, payload, options)
      if (outcome.code !== 0) options.notice(`[hook] ${hook.event} hook failed: ${explain(hook, outcome)}\n`)
    }
  }

  return {
    toolHooks: {
      async beforeCall(call, tool, taskId) {
        for (const hook of forEvent('pre_tool_call').filter((h) => appliesTo(h, call.name))) {
          const outcome = await runHook(
            hook,
            {
              tool: call.name,
              args: call.args,
              permission_level: tool.permissionLevel,
              task_id: taskId,
              cwd: options.cwd,
            },
            options,
          )
          if (outcome.code === 0) continue
          if (outcome.code === BLOCK_EXIT)
            return { block: outcome.stderr || `a pre_tool_call hook refused it (${hook.command})` }
          return { block: `a pre_tool_call hook failed, so the call is refused: ${explain(hook, outcome)}` }
        }
        return undefined
      },
      async afterCall(call, tool, result, taskId) {
        await observe(
          forEvent('post_tool_call').filter((h) => appliesTo(h, call.name)),
          {
            tool: call.name,
            args: call.args,
            permission_level: tool.permissionLevel,
            task_id: taskId,
            cwd: options.cwd,
            result: resultPayload(result),
          },
        )
      },
    },
    session: (event, payload) => observe(forEvent(event), { cwd: options.cwd, ...payload }),
  }
}
