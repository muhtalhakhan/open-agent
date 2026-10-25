import { parse } from 'dotenv'
import { apiKeyVarsFor } from '@open-agent/providers'
import type { SettingView, SettingsGroup } from '@open-agent/web'
import { renderEnvLine } from './init.js'

type Spec = Omit<SettingView, 'value' | 'source'>

/**
 * What the web settings view may change, and nothing else: a request naming
 * any other variable is refused.
 *
 * Left out on purpose, to `open-agent init` and `.env`: the shell tool and its
 * sandbox, the file tool's root, and sharing a logged-in browser profile.
 * Each of those decides how much of this machine, or of the person's
 * accounts, the agent can reach, and a page that can flip them is one stolen
 * token away from handing the agent an unsandboxed shell.
 */
const GROUPS: Array<{ id: string; title: string; description: string; settings: Spec[] }> = [
  {
    id: 'model',
    title: 'Model',
    description: 'The OpenAI-compatible endpoint the agent thinks with.',
    settings: [
      { name: 'OPENAI_BASE_URL', label: 'Base URL', kind: 'url', help: 'For example https://api.openai.com/v1' },
      { name: 'OPENAI_MODEL', label: 'Model', kind: 'text' },
      { name: 'OPENAI_API_KEY', label: 'API key', kind: 'secret' },
      {
        name: 'OPENAI_MODEL_LIGHT',
        label: 'Light model',
        kind: 'text',
        help: 'Optional: a cheaper model on the same endpoint, for tasks the decision layer judges light.',
      },
    ],
  },
  {
    id: 'search',
    title: 'Web search',
    description: 'A search API for the web_search tool. Brave is used when both are set.',
    settings: [
      { name: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search API key', kind: 'secret' },
      { name: 'TAVILY_API_KEY', label: 'Tavily API key', kind: 'secret' },
    ],
  },
  {
    id: 'memory',
    title: 'Memory',
    description: 'A backend for memory that lasts between sessions. Supermemory is used when both are set.',
    settings: [
      { name: 'SUPERMEMORY_API_KEY', label: 'Supermemory API key', kind: 'secret' },
      { name: 'MEM0_API_KEY', label: 'Mem0 API key', kind: 'secret' },
    ],
  },
  {
    id: 'decisions',
    title: 'Jev decisions',
    description:
      "TypeSafe's classifier: the decision tools, and the layer that trims tools and routes light tasks to cut cost.",
    settings: [
      { name: 'TYPESAFE_API_KEY', label: 'TypeSafe API key', kind: 'secret' },
      {
        name: 'DECISION_LAYER',
        label: 'Decision layer',
        kind: 'choice',
        options: ['', 'tools', 'route', 'tools,route'],
        help: 'Sends every task to TypeSafe first. "route" needs a light model.',
      },
    ],
  },
  {
    id: 'browser',
    title: 'Browser',
    description: 'The browser tools, through browser-use (needs `pip install browser-use`, Python 3.11+).',
    settings: [{ name: 'BROWSER_USE', label: 'Browser tools', kind: 'toggle' }],
  },
]

const SPECS = new Map(GROUPS.flatMap((group) => group.settings.map((spec) => [spec.name, spec] as const)))

export interface SettingsDeps {
  envPath: string
  /** The file's content, or `null` when there is none yet. */
  readEnv(): string | null
  /** Writes it readable by its owner alone: it may hold keys. */
  writeEnv(content: string): void
  /** The environment as it was before `.env` was loaded: anything here, `.env` cannot override. */
  shellEnv: Readonly<Record<string, string | undefined>>
  /** Present when `SECRET_STORE=keychain`: new keys go there instead of `.env`. */
  keychain?: { name: string; get(key: string): string | undefined; set(key: string, value: string): void }
  /** Checks a whole environment as startup would; an error message, or `undefined` when it would start. */
  validate(env: Record<string, string | undefined>): string | undefined
}

export type ApplyResult = { ok: true } | { ok: false; error: string }

/**
 * The variable a setting is stored under. The model's key is the one
 * exception to "the name is the variable": the config reads a vendor's own
 * name first (`ANTHROPIC_API_KEY` for api.anthropic.com), so writing
 * `OPENAI_API_KEY` while that one is set would save a key nothing reads.
 */
function variableFor(name: string, baseURL: string, isSet: (variable: string) => boolean): string {
  if (name !== 'OPENAI_API_KEY') return name
  const candidates = apiKeyVarsFor(baseURL)
  return candidates.find(isSet) ?? candidates[0]
}

/** A keychain lookup that cannot fail the page: a locked keychain reads as "not there". */
function inKeychain(deps: SettingsDeps, variable: string): boolean {
  try {
    return deps.keychain?.get(variable) !== undefined
  } catch {
    return false
  }
}

export function readSettings(deps: SettingsDeps): SettingsGroup[] {
  const file = parse(deps.readEnv() ?? '')
  const baseURL = deps.shellEnv.OPENAI_BASE_URL ?? file.OPENAI_BASE_URL ?? ''
  const isSet = (variable: string) =>
    deps.shellEnv[variable] !== undefined || file[variable] !== undefined || inKeychain(deps, variable)

  return GROUPS.map(({ settings, ...group }) => ({
    ...group,
    settings: settings.map((spec): SettingView => {
      const variable = variableFor(spec.name, baseURL, isSet)
      const source: SettingView['source'] =
        deps.shellEnv[variable] !== undefined
          ? 'shell'
          : file[variable] !== undefined
            ? 'env-file'
            : spec.kind === 'secret' && inKeychain(deps, variable)
              ? 'keychain'
              : 'unset'
      const value = deps.shellEnv[variable] ?? file[variable]
      return { ...spec, source, ...(spec.kind !== 'secret' && value !== undefined ? { value } : {}) }
    }),
  }))
}

function checkValue(spec: Spec, value: string): string | undefined {
  if (/[\r\n]/.test(value)) return `${spec.label} cannot contain a line break.`
  if (spec.kind === 'url') {
    const protocol = URL.canParse(value) ? new URL(value).protocol : ''
    if (protocol !== 'http:' && protocol !== 'https:') return `${spec.label} must be an http(s) URL.`
  }
  if (spec.kind === 'toggle' && value !== '1' && value !== '0') return `${spec.label} must be on or off.`
  if (spec.kind === 'choice' && !spec.options?.includes(value)) return `${spec.label} must be one of the listed values.`
  if ((spec.kind === 'text' || spec.kind === 'secret') && !value.trim()) return `${spec.label} cannot be empty.`
  return undefined
}

/**
 * Edits `.env` in place: the lines for the changed variables are replaced or
 * removed, and everything else — settings this view does not manage,
 * comments, their order — is kept as it was.
 */
export function editEnv(content: string, changes: Map<string, string | null>): string {
  const pending = new Map(changes)
  const seen = new Set<string>()
  const lines: string[] = []
  for (const line of content.split('\n')) {
    const name = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]
    if (!name || !changes.has(name)) {
      lines.push(line)
      continue
    }
    // A later duplicate would override the edit when dotenv reads the file.
    if (seen.has(name)) continue
    seen.add(name)
    const value = changes.get(name)
    if (value !== null && value !== undefined) lines.push(renderEnvLine(name, value))
    pending.delete(name)
  }
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  for (const [name, value] of pending) if (value !== null) lines.push(renderEnvLine(name, value))
  return `${lines.join('\n')}\n`
}

/**
 * Applies changes from the settings view: validated as a whole before
 * anything is written, so a change that would stop the agent starting is
 * refused rather than saved. Keys go to the keychain when one is configured,
 * and are then taken out of `.env`, which the config reads first and which
 * would otherwise go on shadowing them.
 */
export function applySettings(deps: SettingsDeps, changes: Record<string, string | null>): ApplyResult {
  const existing = deps.readEnv()
  const file = parse(existing ?? '')
  const isSet = (variable: string) =>
    deps.shellEnv[variable] !== undefined || file[variable] !== undefined || inKeychain(deps, variable)
  const baseURL = changes.OPENAI_BASE_URL ?? deps.shellEnv.OPENAI_BASE_URL ?? file.OPENAI_BASE_URL ?? ''

  const fileChanges = new Map<string, string | null>()
  const keychainWrites = new Map<string, string>()
  for (const [name, raw] of Object.entries(changes)) {
    const spec = SPECS.get(name)
    if (!spec) return { ok: false, error: `"${name}" cannot be changed here.` }
    const value = raw === null ? null : raw.trim()
    if (value !== null) {
      const problem = checkValue(spec, value)
      if (problem) return { ok: false, error: problem }
    }
    const variable = variableFor(name, baseURL, isSet)
    if (deps.shellEnv[variable] !== undefined) {
      return {
        ok: false,
        error: `${variable} is set in the environment the agent was started from, which .env cannot override. Change it there.`,
      }
    }
    if (value === null) {
      if (file[variable] === undefined && inKeychain(deps, variable)) {
        return {
          ok: false,
          error: `${variable} is in the ${deps.keychain?.name}; remove it with your keychain tool.`,
        }
      }
      fileChanges.set(variable, null)
    } else if (spec.kind === 'secret' && deps.keychain) {
      keychainWrites.set(variable, value)
      fileChanges.set(variable, null)
    } else {
      fileChanges.set(variable, value)
    }
  }

  let next: string
  try {
    next = editEnv(
      existing ?? '# Written by the open-agent web settings. Every setting is described in .env.example.\n',
      fileChanges,
    )
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  // What startup would see: the shell's variables over the new file, with
  // the keys about to go to the keychain standing in for the lookup that
  // would find them there.
  const problem = deps.validate({ ...parse(next), ...Object.fromEntries(keychainWrites), ...deps.shellEnv })
  if (problem) return { ok: false, error: `Not saved: ${problem}` }

  // The keychain first: if it refuses, .env has not been touched, and no
  // setting points at a key that is not there.
  try {
    for (const [variable, value] of keychainWrites) deps.keychain?.set(variable, value)
  } catch (err) {
    return {
      ok: false,
      error: `The ${deps.keychain?.name} refused the key: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (fileChanges.size > 0) deps.writeEnv(next)
  return { ok: true }
}
