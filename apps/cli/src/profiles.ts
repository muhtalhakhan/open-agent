import fs from 'node:fs'
import path from 'node:path'
import yaml from 'yaml'
import type { CliConfig } from './config.js'

/** The tools a profile can switch on or off. Each maps to the `enabled` flag of its section in `CliConfig`. */
export const PROFILE_TOOLS = ['browser', 'computer', 'http', 'files', 'shell'] as const
export type ProfileTool = (typeof PROFILE_TOOLS)[number]

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
  return validateProfile(parsed, source)
}

/** The checks behind `parseProfile`, for a profile that arrives as data — from the web editor — rather than YAML. */
export function validateProfile(parsed: unknown, source: string): ProfileResult {
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

export type ProfileWriteResult = { ok: true; file: string; profile: AgentProfile } | { ok: false; error: string }

/**
 * Writes a profile into the user's folder as `<fileName>.yaml`. The file name
 * is held to `PROFILE_NAME`, so nothing — least of all the `name` inside a
 * file someone else sent — can place it outside the folder. An existing file
 * is replaced only when `replace` says so: importing a shared
 * `coding-agent.yaml` must not quietly overwrite your own.
 */
export function writeProfile(
  dirs: ProfileDirs,
  fileName: string,
  profile: AgentProfile,
  { replace = false }: { replace?: boolean } = {},
): ProfileWriteResult {
  if (!PROFILE_NAME.test(fileName)) {
    return { ok: false, error: `"${fileName}" is not a valid profile name: use letters, digits, ".", "_" and "-".` }
  }
  const file = path.join(dirs.user, `${fileName}.yaml`)
  try {
    fs.mkdirSync(dirs.user, { recursive: true })
    fs.writeFileSync(file, yaml.stringify(profile), { flag: replace ? 'w' : 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, error: `${file} already exists. Remove it first, or choose another name.` }
    }
    return { ok: false, error: `Can't write ${file}: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true, file, profile }
}

/** Copies a profile to a new name in the user's folder, as a starting point to edit. */
export function duplicateProfile(source: string, newName: string, dirs: ProfileDirs): ProfileWriteResult {
  const loaded = loadProfile(source, dirs)
  if (!loaded.ok) return loaded
  return writeProfile(dirs, newName, { ...loaded.profile, name: newName })
}

/**
 * The profile as YAML, for sharing. Re-serialised from the parsed profile
 * rather than copied as text, so what goes out has passed validation.
 */
export function exportProfile(
  source: string,
  dirs: ProfileDirs,
): { ok: true; yaml: string } | { ok: false; error: string } {
  const loaded = loadProfile(source, dirs)
  if (!loaded.ok) return loaded
  return { ok: true, yaml: yaml.stringify(loaded.profile) }
}

/**
 * Adds a profile someone shared to the user's folder, under its file name
 * (`coding-agent.yaml` becomes `--profile coding-agent`). The `name` inside is
 * a display name and plays no part in where the file goes.
 */
export function importProfile(file: string, dirs: ProfileDirs): ProfileWriteResult {
  if (!/\.ya?ml$/.test(file)) return { ok: false, error: `${file} is not a .yaml file.` }
  const loaded = loadProfile(file, dirs)
  if (!loaded.ok) return loaded
  return writeProfile(dirs, path.basename(file).replace(/\.ya?ml$/, ''), loaded.profile)
}

/** One profile file found by `listProfiles`: the profile, or why it did not load. */
export type ListedProfile = { id: string; origin: 'user' | 'example' } & (
  { profile: AgentProfile; error?: undefined } | { profile?: undefined; error: string }
)

function profileFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((entry) => entry.endsWith('.yaml') && PROFILE_NAME.test(entry.slice(0, -'.yaml'.length)))
      .sort()
  } catch {
    // No folder yet is no profiles yet.
    return []
  }
}

/**
 * Every profile `--profile <name>` can reach: the user's own, then the
 * examples that none of theirs shadows. Files that fail to load are listed
 * with the reason, so a typo shows up rather than the profile vanishing.
 */
export function listProfiles(dirs: ProfileDirs): ListedProfile[] {
  const listed: ListedProfile[] = []
  const seen = new Set<string>()
  for (const [dir, origin] of [
    [dirs.user, 'user'],
    [dirs.examples, 'example'],
  ] as const) {
    for (const entry of profileFiles(dir)) {
      const id = entry.slice(0, -'.yaml'.length)
      if (seen.has(id)) continue
      seen.add(id)
      const file = path.join(dir, entry)
      let content: string
      try {
        content = fs.readFileSync(file, 'utf8')
      } catch (err) {
        listed.push({ id, origin, error: `Can't read ${file}: ${String(err)}` })
        continue
      }
      const parsed = parseProfile(content, file)
      listed.push(parsed.ok ? { id, origin, profile: parsed.profile } : { id, origin, error: parsed.error })
    }
  }
  return listed
}

/** Removes one of the user's own profiles. The examples are part of the checkout and stay. */
export function deleteProfile(id: string, dirs: ProfileDirs): { ok: true } | { ok: false; error: string } {
  if (!PROFILE_NAME.test(id)) return { ok: false, error: `"${id}" is not a valid profile name.` }
  const file = path.join(dirs.user, `${id}.yaml`)
  try {
    fs.unlinkSync(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: `"${id}" is not one of your profiles in ${dirs.user}.` }
    }
    return { ok: false, error: `Can't remove ${file}: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true }
}
