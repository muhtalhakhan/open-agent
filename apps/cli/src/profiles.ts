import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'
import type { CliConfig } from './config.js'

/** The tools a profile can switch on or off. Each maps to the `enabled` flag of its section in `CliConfig`. */
const PROFILE_TOOLS = ['browser', 'computer', 'http', 'files', 'shell'] as const
type ProfileTool = (typeof PROFILE_TOOLS)[number]

/**
 * A named set of settings applied over the `.env` config. Deliberately small:
 * a field is here only if `CliConfig` has somewhere to put it, so a profile
 * can't carry a setting that loads without error and then does nothing.
 * Permissions are absent on purpose — profiles are meant to be shared, and
 * tool approval goes through `ToolRegistry.decide` alone.
 */
export interface AgentProfile {
  name: string
  /** Sent to the endpoint in `OPENAI_BASE_URL`, so it must be a model id that endpoint knows. */
  model: string
  tools?: Partial<Record<ProfileTool, boolean>>
}

export type ProfileResult = { ok: true; profile: AgentProfile } | { ok: false; error: string }

/** Where profiles are looked up by name: the user's own first, then the examples in the checkout. */
export interface ProfileDirs {
  /** `~/.openagent/profiles`, passed in so tests never touch the real one. */
  user: string
  /** `examples/profiles` in the repo, resolved from the CLI's location rather than the cwd. */
  examples: string
}

/**
 * A profile name is a file name, so it is held to characters that can't climb
 * out of the folder (`../`) or hide (a leading dot).
 */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Checks the parsed YAML has the shape `AgentProfile` claims, rather than trusting a cast. */
export function parseProfile(content: string, source: string): ProfileResult {
  let parsed: unknown
  try {
    parsed = yaml.parse(content)
  } catch (err) {
    return {
      ok: false,
      error: `Profile ${source} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `Profile ${source} must be a YAML mapping.` }
  }
  const fields = parsed as Record<string, unknown>
  const unknown = Object.keys(fields).filter((key) => !['name', 'model', 'tools'].includes(key))
  if (unknown.length > 0) {
    return { ok: false, error: `Profile ${source} has unsupported fields: ${unknown.join(', ')}.` }
  }
  if (typeof fields.name !== 'string' || fields.name.trim() === '') {
    return { ok: false, error: `Profile ${source} needs a "name".` }
  }
  if (typeof fields.model !== 'string' || fields.model.trim() === '') {
    return { ok: false, error: `Profile ${source} needs a "model".` }
  }
  const profile: AgentProfile = { name: fields.name, model: fields.model }
  if (fields.tools !== undefined) {
    if (fields.tools === null || typeof fields.tools !== 'object' || Array.isArray(fields.tools)) {
      return { ok: false, error: `Profile ${source}: "tools" must be a mapping of tool names to true or false.` }
    }
    const tools: Partial<Record<ProfileTool, boolean>> = {}
    for (const [tool, enabled] of Object.entries(fields.tools)) {
      if (!(PROFILE_TOOLS as readonly string[]).includes(tool)) {
        return {
          ok: false,
          error: `Profile ${source}: unknown tool "${tool}". Profiles can set ${PROFILE_TOOLS.join(', ')}.`,
        }
      }
      if (typeof enabled !== 'boolean') {
        return { ok: false, error: `Profile ${source}: tools.${tool} must be true or false.` }
      }
      tools[tool as ProfileTool] = enabled
    }
    profile.tools = tools
  }
  return { ok: true, profile }
}

/**
 * Loads a profile by name or path. Anything with a slash or a `.yaml`/`.yml`
 * extension is a path; anything else is a name, looked up in the user's
 * folder before the examples so a user can shadow an example by copying it.
 */
export function loadProfile(nameOrPath: string, dirs: ProfileDirs): ProfileResult {
  const isPath = /[/\\]/.test(nameOrPath) || /\.ya?ml$/.test(nameOrPath)
  let file: string
  if (isPath) {
    file = path.resolve(nameOrPath)
  } else {
    if (!PROFILE_NAME.test(nameOrPath)) {
      return { ok: false, error: `"${nameOrPath}" is not a valid profile name.` }
    }
    const found = [dirs.user, dirs.examples]
      .map((dir) => path.join(dir, `${nameOrPath}.yaml`))
      .find((candidate) => fs.existsSync(candidate))
    if (!found) {
      return { ok: false, error: `Profile "${nameOrPath}" not found in ${dirs.user} or ${dirs.examples}.` }
    }
    file = found
  }
  let content: string
  try {
    content = fs.readFileSync(file, 'utf8')
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    return {
      ok: false,
      error: missing ? `Profile file ${file} not found.` : `Can't read profile ${file}: ${String(err)}`,
    }
  }
  return parseProfile(content, file)
}

/**
 * The profile wins for every field it sets, and leaves the rest of the config
 * as `.env` made it. Applied to the parsed config rather than to `process.env`,
 * so it holds the same way in the REPL, print mode and `web`.
 */
export function applyProfile(config: CliConfig, profile: AgentProfile): CliConfig {
  const tools = profile.tools ?? {}
  return {
    ...config,
    llm: { ...config.llm, model: profile.model },
    browser: { ...config.browser, enabled: tools.browser ?? config.browser.enabled },
    computer: { ...config.computer, enabled: tools.computer ?? config.computer.enabled },
    http: { ...config.http, enabled: tools.http ?? config.http.enabled },
    files: { ...config.files, enabled: tools.files ?? config.files.enabled },
    shell: { ...config.shell, enabled: tools.shell ?? config.shell.enabled },
  }
}
