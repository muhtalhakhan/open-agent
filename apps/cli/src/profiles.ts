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
