export interface CliConfig {
  llm: { baseURL: string; apiKey: string; model: string }
  browserUse: boolean
  http: { enabled: boolean; allowedHosts?: string[]; secrets: Record<string, string> }
  memory:
    | { provider: 'supermemory'; apiKey: string; baseURL?: string }
    | { provider: 'mem0'; apiKey: string }
    | { provider: 'none' }
}

export type ConfigResult = { ok: true; config: CliConfig } | { ok: false; error: string }

/** Pure, testable parse of the environment into a CliConfig. See .env.example for the full list. */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv): ConfigResult {
  const baseURL = env.OPENAI_BASE_URL
  const apiKey = env.OPENAI_API_KEY
  const model = env.OPENAI_MODEL
  if (!baseURL || !apiKey || !model) {
    return { ok: false, error: 'Set OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL (see .env.example).' }
  }

  const browserUse = env.BROWSER_USE === '1' || env.BROWSER_USE === 'true'
  const http = loadHttpToolConfig(env)

  let memory: CliConfig['memory'] = { provider: 'none' }
  if (env.SUPERMEMORY_API_KEY) {
    memory = { provider: 'supermemory', apiKey: env.SUPERMEMORY_API_KEY, baseURL: env.SUPERMEMORY_BASE_URL }
  } else if (env.MEM0_API_KEY) {
    memory = { provider: 'mem0', apiKey: env.MEM0_API_KEY }
  }

  return { ok: true, config: { llm: { baseURL, apiKey, model }, browserUse, http, memory } }
}

/**
 * `HTTP_TOOL=1` turns the tool on, `HTTP_ALLOWED_HOSTS` narrows where it may
 * go, and every `HTTP_SECRET_<NAME>` becomes the `{{NAME}}` placeholder the
 * model can put in a header without the value entering its context. Reading
 * credentials straight from the environment is the stand-in until a real
 * secret store exists.
 */
function loadHttpToolConfig(env: NodeJS.ProcessEnv): CliConfig['http'] {
  const enabled = env.HTTP_TOOL === '1' || env.HTTP_TOOL === 'true'
  const hosts = (env.HTTP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)

  const secrets: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('HTTP_SECRET_') && value) secrets[key.slice('HTTP_SECRET_'.length)] = value
  }

  // An unset HTTP_ALLOWED_HOSTS means "no restriction"; an empty one would
  // otherwise silently become an allowlist that permits nothing.
  return { enabled, allowedHosts: env.HTTP_ALLOWED_HOSTS === undefined ? undefined : hosts, secrets }
}
