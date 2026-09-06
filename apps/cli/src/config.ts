import { apiKeyVarsFor, resolveCredential, type CredentialLookup, type CredentialResult } from '@open-agent/providers'

export interface CliConfig {
  llm: { baseURL: string; apiKey: string; model: string }
  browserUse: boolean
  http: { enabled: boolean; allowedHosts?: string[]; secrets: Record<string, string> }
  files: { enabled: boolean; root?: string; deny?: string[]; allow?: string[]; readOnly: boolean }
  /** Where the file and shell tools work, and whether it is provisioned per run. */
  workspace: { session: boolean; base?: string }
  shell: {
    enabled: boolean
    root?: string
    allowedCommands?: string[]
    allowEnv?: string[]
    timeoutMs?: number
  }
  search: { provider: 'brave'; apiKey: string } | { provider: 'tavily'; apiKey: string } | { provider: 'none' }
  memory:
    | { provider: 'supermemory'; apiKey: string; baseURL?: string }
    | { provider: 'mem0'; apiKey: string }
    | { provider: 'none' }
  /**
   * Every secret value the config resolved, collected in one place so the
   * caller can hand them to `createRedactingLogger`. Deliberately not a map
   * from variable name to value: nothing should be looking a credential up by
   * name from here, only filtering it back out of text.
   */
  secrets: string[]
}

export type ConfigResult = { ok: true; config: CliConfig } | { ok: false; error: string }

/**
 * Parses the environment into a `CliConfig`. See .env.example for the full list.
 *
 * Every credential goes through `resolveCredential`, so each one also accepts
 * a `<NAME>_FILE` variant pointing at a file holding the value — the shape
 * Docker and Kubernetes secrets arrive in. `readFile` is injectable so tests
 * stay off the disk; with it stubbed the function is as pure as it was before.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv, readFile?: CredentialLookup['readFile']): ConfigResult {
  const lookup: CredentialLookup = { env, readFile }
  const secrets: string[] = []

  /**
   * Resolves an optional credential. A `missing` one is simply absent, but an
   * unreadable or malformed one is an operator mistake worth stopping for:
   * silently disabling search because a secret file had a typo in its path is
   * how you end up debugging the agent instead of the config.
   */
  const optional = (names: string | string[]): { value?: string; error?: string } => {
    const result = resolveCredential(names, lookup)
    if (result.ok) {
      secrets.push(result.value)
      return { value: result.value }
    }
    return result.reason === 'missing' ? {} : { error: result.error }
  }

  const baseURL = env.OPENAI_BASE_URL
  const model = env.OPENAI_MODEL
  // Resolved against the base URL's vendor first (OPENROUTER_API_KEY and
  // friends), falling back to the generic name that works for every
  // OpenAI-compatible endpoint.
  const apiKey: CredentialResult = resolveCredential(apiKeyVarsFor(baseURL ?? ''), lookup)
  if (!baseURL || !model || (!apiKey.ok && apiKey.reason === 'missing')) {
    return { ok: false, error: 'Set OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL (see .env.example).' }
  }
  if (!apiKey.ok) return { ok: false, error: apiKey.error }
  secrets.push(apiKey.value)

  const browserUse = env.BROWSER_USE === '1' || env.BROWSER_USE === 'true'

  const http = loadHttpToolConfig(env, lookup, secrets)
  if (!http.ok) return { ok: false, error: http.error }

  // Off unless asked for, like the HTTP tool: handing a model the filesystem
  // is a decision to make on purpose, not a default to discover afterwards.
  // Left undefined rather than defaulted to the cwd here: this function is a
  // read of the environment, and the launch directory is not part of it.
  // `FILES_DENY`/`FILES_ALLOW` add to the built-in secret list rather than
  // replacing it: an operator naming one extra private directory should not
  // silently lose the `.env` protection they never had to ask for.
  const commaList = (value: string | undefined) => {
    const items = (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    return items.length > 0 ? items : undefined
  }
  const files = {
    enabled: env.FILES_TOOL === '1' || env.FILES_TOOL === 'true',
    root: env.FILES_ROOT || undefined,
    deny: commaList(env.FILES_DENY),
    allow: commaList(env.FILES_ALLOW),
    readOnly: env.FILES_READONLY === '1' || env.FILES_READONLY === 'true',
  }

  const workspace = {
    session: env.WORKSPACE_SESSION === '1' || env.WORKSPACE_SESSION === 'true',
    base: env.WORKSPACE_BASE || undefined,
  }

  const shell = loadShellToolConfig(env)
  if (!shell.ok) return { ok: false, error: shell.error }

  // Keyed off which key is present rather than a separate on/off flag: a
  // search API is useless without one, and there is nothing to enable without.
  let search: CliConfig['search'] = { provider: 'none' }
  const brave = optional('BRAVE_SEARCH_API_KEY')
  if (brave.error) return { ok: false, error: brave.error }
  const tavily = optional('TAVILY_API_KEY')
  if (tavily.error) return { ok: false, error: tavily.error }
  if (brave.value) {
    search = { provider: 'brave', apiKey: brave.value }
  } else if (tavily.value) {
    search = { provider: 'tavily', apiKey: tavily.value }
  }

  let memory: CliConfig['memory'] = { provider: 'none' }
  const supermemory = optional('SUPERMEMORY_API_KEY')
  if (supermemory.error) return { ok: false, error: supermemory.error }
  const mem0 = optional('MEM0_API_KEY')
  if (mem0.error) return { ok: false, error: mem0.error }
  if (supermemory.value) {
    memory = { provider: 'supermemory', apiKey: supermemory.value, baseURL: env.SUPERMEMORY_BASE_URL }
  } else if (mem0.value) {
    memory = { provider: 'mem0', apiKey: mem0.value }
  }

  return {
    ok: true,
    config: {
      llm: { baseURL, apiKey: apiKey.value, model },
      browserUse,
      http: http.config,
      files,
      workspace,
      shell: shell.config,
      search,
      memory,
      secrets,
    },
  }
}

/**
 * `SHELL_TOOL=1` turns the shell tool on. It runs under `SHELL_ROOT`, falling
 * back to `FILES_ROOT` so the two tools share one workspace by default — an
 * agent that can read a directory and run commands somewhere else would be a
 * strange thing to configure by accident.
 *
 * `SHELL_ALLOWED_COMMANDS` narrows it to a list of programs, and
 * `SHELL_ALLOW_ENV` names credential variables to pass through that the tool
 * would otherwise hide. Neither has a default: the tool is already behind an
 * approval prompt on every call.
 */
function loadShellToolConfig(
  env: NodeJS.ProcessEnv,
): { ok: true; config: CliConfig['shell'] } | { ok: false; error: string } {
  const enabled = env.SHELL_TOOL === '1' || env.SHELL_TOOL === 'true'
  const list = (value: string | undefined) => {
    const items = (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    return items.length > 0 ? items : undefined
  }

  let timeoutMs: number | undefined
  if (env.SHELL_TIMEOUT_MS !== undefined && env.SHELL_TIMEOUT_MS !== '') {
    timeoutMs = Number(env.SHELL_TIMEOUT_MS)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      return { ok: false, error: 'SHELL_TIMEOUT_MS must be a positive whole number of milliseconds.' }
    }
  }

  return {
    ok: true,
    config: {
      enabled,
      root: env.SHELL_ROOT || env.FILES_ROOT || undefined,
      allowedCommands: list(env.SHELL_ALLOWED_COMMANDS),
      allowEnv: list(env.SHELL_ALLOW_ENV),
      timeoutMs,
    },
  }
}

/**
 * `HTTP_TOOL=1` turns the tool on, `HTTP_ALLOWED_HOSTS` narrows where it may
 * go, and every `HTTP_SECRET_<NAME>` becomes the `{{NAME}}` placeholder the
 * model can put in a header without the value entering its context.
 * `HTTP_SECRET_<NAME>_FILE` supplies the same placeholder from a file.
 */
function loadHttpToolConfig(
  env: NodeJS.ProcessEnv,
  lookup: CredentialLookup,
  secrets: string[],
): { ok: true; config: CliConfig['http'] } | { ok: false; error: string } {
  const enabled = env.HTTP_TOOL === '1' || env.HTTP_TOOL === 'true'
  const hosts = (env.HTTP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)

  // Both spellings name the same placeholder, so the `_FILE` suffix is
  // stripped before the name is collected and the set is de-duplicated —
  // otherwise `HTTP_SECRET_TOKEN_FILE` would offer the model a `{{TOKEN_FILE}}`
  // that resolves to nothing.
  const names = new Set<string>()
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('HTTP_SECRET_') || !value) continue
    const name = key.slice('HTTP_SECRET_'.length)
    names.add(name.endsWith('_FILE') ? name.slice(0, -'_FILE'.length) : name)
  }

  const resolved: Record<string, string> = {}
  for (const name of names) {
    if (name === '') continue
    const result = resolveCredential(`HTTP_SECRET_${name}`, lookup)
    if (!result.ok) return { ok: false, error: result.error }
    resolved[name] = result.value
    secrets.push(result.value)
  }

  // An unset HTTP_ALLOWED_HOSTS means "no restriction"; an empty one would
  // otherwise silently become an allowlist that permits nothing.
  return {
    ok: true,
    config: { enabled, allowedHosts: env.HTTP_ALLOWED_HOSTS === undefined ? undefined : hosts, secrets: resolved },
  }
}
