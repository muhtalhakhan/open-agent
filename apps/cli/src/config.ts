export interface CliConfig {
  llm: { baseURL: string; apiKey: string; model: string }
  browserUse: boolean
  memory: { provider: 'supermemory'; apiKey: string; baseURL?: string } | { provider: 'mem0'; apiKey: string } | { provider: 'none' }
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

  let memory: CliConfig['memory'] = { provider: 'none' }
  if (env.SUPERMEMORY_API_KEY) {
    memory = { provider: 'supermemory', apiKey: env.SUPERMEMORY_API_KEY, baseURL: env.SUPERMEMORY_BASE_URL }
  } else if (env.MEM0_API_KEY) {
    memory = { provider: 'mem0', apiKey: env.MEM0_API_KEY }
  }

  return { ok: true, config: { llm: { baseURL, apiKey, model }, browserUse, memory } }
}
