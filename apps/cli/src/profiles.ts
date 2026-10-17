import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import yaml from 'yaml'

export interface AgentProfile {
  name: string
  model: string
  tools: {
    browser?: boolean
    computer?: boolean
    http?: boolean
    files?: boolean
    shell?: boolean
    docker?: boolean
    email?: boolean
    calendar?: boolean
  }
  memory?: boolean
  permissions?: Record<string, string>
}

export function loadProfile(
  profileNameOrPath: string,
): { ok: true; profile: AgentProfile } | { ok: false; error: string } {
  let filePath = profileNameOrPath

  // If it doesn't look like a file path (no extension or slash), resolve from ~/.openagent/profiles/ or examples/profiles/
  if (
    !filePath.includes('/') &&
    !filePath.includes('\\') &&
    !filePath.endsWith('.yaml') &&
    !filePath.endsWith('.yml')
  ) {
    const homeDir = os.homedir()
    const userPath = path.join(homeDir, '.openagent', 'profiles', `${filePath}.yaml`)
    const repoPath = path.resolve(process.cwd(), 'examples', 'profiles', `${filePath}.yaml`)

    if (fs.existsSync(userPath)) {
      filePath = userPath
    } else if (fs.existsSync(repoPath)) {
      filePath = repoPath
    } else {
      return { ok: false, error: `Profile "${filePath}" not found in ~/.openagent/profiles/ or examples/profiles/.` }
    }
  }

  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `Profile file not found at "${filePath}".` }
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const parsed = yaml.parse(content) as AgentProfile
    if (!parsed || typeof parsed !== 'object' || !parsed.model) {
      return { ok: false, error: `Invalid profile format in "${filePath}": missing "model" field.` }
    }
    return { ok: true, profile: parsed }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse profile YAML at "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** Duplicate a profile: copy settings to a new name with clean memory/session. */
export function duplicateProfile(
  sourceNameOrPath: string,
  newName: string,
): { ok: true; profilePath: string } | { ok: false; error: string } {
  try {
    const source = loadProfile(sourceNameOrPath)
    if (!source.ok) return source
    const newProfile: AgentProfile = { ...source.profile, name: newName, memory: false }
    const homeDir = os.homedir()
    const outDir = path.join(homeDir, '.openagent', 'profiles')
    fs.mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `${newName}.yaml`)
    fs.writeFileSync(outPath, yaml.stringify(newProfile))
    return { ok: true, profilePath: outPath }
  } catch (err) {
    return { ok: false, error: `Failed to duplicate profile: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Export profile to YAML string (no session data; clean memory). */
export function exportProfile(profileNameOrPath: string): { ok: true; yaml: string } | { ok: false; error: string } {
  const result = loadProfile(profileNameOrPath)
  if (!result.ok) return result
  const profile: AgentProfile = { ...result.profile, memory: false }
  return { ok: true, yaml: yaml.stringify(profile) }
}

/** Import profile from YAML file/content (validates name + model). */
export function importProfile(
  yamlContent: string,
  destinationName?: string,
): { ok: true; profilePath: string } | { ok: false; error: string } {
  try {
    const parsed = yaml.parse(yamlContent) as AgentProfile
    if (!parsed || typeof parsed !== 'object' || !parsed.model || !parsed.name) {
      return { ok: false, error: 'Invalid profile: missing "name" or "model".' }
    }
    const name = destinationName || parsed.name
    const homeDir = os.homedir()
    const outDir = path.join(homeDir, '.openagent', 'profiles')
    fs.mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `${name}.yaml`)
    fs.writeFileSync(outPath, yaml.stringify({ ...parsed, name }))
    return { ok: true, profilePath: outPath }
  } catch (err) {
    return { ok: false, error: `Failed to import profile: ${err instanceof Error ? err.message : String(err)}` }
  }
}
