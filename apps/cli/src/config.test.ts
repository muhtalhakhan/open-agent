import { describe, expect, it } from 'vitest'
import { MemorySecretStore } from '@open-agent/security'
import { loadConfigFromEnv, type OpenKeychain } from './config.js'

describe('loadConfigFromEnv', () => {
  it('fails when the required OpenAI-compatible env vars are missing', () => {
    const result = loadConfigFromEnv({})
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/OPENAI_BASE_URL/) })
  })

  it('parses the minimal required config with memory defaulting to none', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
    })
    expect(result).toEqual({
      ok: true,
      config: {
        llm: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-x', model: 'gpt-4o-mini' },
        browser: { enabled: false, profileDir: undefined, keepProfile: false, allowEnv: undefined },
        computer: { enabled: false, model: undefined },
        http: { enabled: false, allowedHosts: undefined, deniedHosts: undefined, allowLocal: false, secrets: {} },
        files: { enabled: false, root: undefined, deny: undefined, allow: undefined, readOnly: false },
        workspace: { session: false, base: undefined },
        shell: {
          enabled: false,
          root: undefined,
          sandbox: 'auto',
          sandboxImage: undefined,
          network: false,
          allowedCommands: undefined,
          allowEnv: undefined,
          timeoutMs: undefined,
        },
        search: { provider: 'none' },
        memory: { provider: 'none' },
        secrets: ['sk-x'],
      },
    })
  })

  it('enables browser-use when BROWSER_USE=1', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      BROWSER_USE: '1',
    })
    expect(result.ok && result.config.browser.enabled).toBe(true)
  })

  it('enables computer-use when COMPUTER_USE=1', () => {
    const result = loadConfigFromEnv({ ...base(), COMPUTER_USE: '1' })
    expect(result.ok && result.config.computer).toEqual({ enabled: true, model: undefined })
  })

  it('accepts COMPUTER_USE=true as well as 1, and stays off otherwise', () => {
    expect(loadConfigFromEnv({ ...base(), COMPUTER_USE: 'true' }).ok && true).toBe(true)
    const off = loadConfigFromEnv({ ...base(), COMPUTER_USE: 'yes' })
    expect(off.ok && off.config.computer.enabled).toBe(false)
  })

  it('lets COMPUTER_USE_MODEL override the model without touching the LLM config', () => {
    const result = loadConfigFromEnv({ ...base(), COMPUTER_USE: '1', COMPUTER_USE_MODEL: 'ui-tars-7b-dpo' })
    expect(result.ok && result.config.computer.model).toBe('ui-tars-7b-dpo')
    expect(result.ok && result.config.llm.model).toBe('gpt-4o-mini')
  })

  it('uses a throwaway browser profile unless one is named', () => {
    const result = loadConfigFromEnv({ ...base(), BROWSER_USE: '1' })
    expect(result.ok && result.config.browser.profileDir).toBeUndefined()
  })

  it('treats a named profile directory as the opt-in to sharing', () => {
    const result = loadConfigFromEnv({
      ...base(),
      BROWSER_USE: '1',
      BROWSER_PROFILE_DIR: '/home/u/.config/google-chrome',
      BROWSER_ALLOW_ENV: 'GH_TOKEN',
      BROWSER_KEEP_PROFILE: '1',
    })
    expect(result.ok && result.config.browser).toEqual({
      enabled: true,
      profileDir: '/home/u/.config/google-chrome',
      keepProfile: true,
      allowEnv: ['GH_TOKEN'],
    })
  })
  it('enables the read_file tool with an explicit root when FILES_TOOL=1', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      FILES_TOOL: '1',
      FILES_ROOT: '/srv/workspace',
    })
    expect(result.ok && result.config.files).toEqual({
      enabled: true,
      root: '/srv/workspace',
      deny: undefined,
      allow: undefined,
      readOnly: false,
    })
  })

  it('leaves the file root unset so the caller can supply the launch directory', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      FILES_TOOL: 'true',
    })
    expect(result.ok && result.config.files).toEqual({
      enabled: true,
      root: undefined,
      deny: undefined,
      allow: undefined,
      readOnly: false,
    })
  })

  it('leaves the http tool off, unrestricted and secret-free by default', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
    })
    expect(result.ok && result.config.http).toEqual({
      enabled: false,
      allowedHosts: undefined,
      deniedHosts: undefined,
      allowLocal: false,
      secrets: {},
    })
  })

  it('enables the http tool with its allowlist and HTTP_SECRET_* placeholders', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      HTTP_TOOL: '1',
      HTTP_ALLOWED_HOSTS: 'api.stripe.com, api.github.com',
      HTTP_SECRET_STRIPE_KEY: 'sk-live-1',
    })
    expect(result.ok && result.config.http).toEqual({
      enabled: true,
      allowedHosts: ['api.stripe.com', 'api.github.com'],
      deniedHosts: undefined,
      allowLocal: false,
      secrets: { STRIPE_KEY: 'sk-live-1' },
    })
  })

  it('reads the denied host list and the local-address opt-in', () => {
    const result = loadConfigFromEnv({
      ...base(),
      HTTP_TOOL: '1',
      HTTP_DENIED_HOSTS: 'internal.corp, metadata.google.internal',
      HTTP_ALLOW_LOCAL: '1',
    })
    expect(result.ok && result.config.http).toMatchObject({
      deniedHosts: ['internal.corp', 'metadata.google.internal'],
      allowLocal: true,
    })
  })
  it('reads an empty HTTP_ALLOWED_HOSTS as an allowlist of nothing, not as no allowlist', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      HTTP_TOOL: '1',
      HTTP_ALLOWED_HOSTS: '',
    })
    expect(result.ok && result.config.http.allowedHosts).toEqual([])
  })

  it('enables brave web search when BRAVE_SEARCH_API_KEY is set', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      BRAVE_SEARCH_API_KEY: 'brave-1',
    })
    expect(result.ok && result.config.search).toEqual({ provider: 'brave', apiKey: 'brave-1' })
  })

  it('falls back to tavily when only TAVILY_API_KEY is set', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      TAVILY_API_KEY: 'tvly-1',
    })
    expect(result.ok && result.config.search).toEqual({ provider: 'tavily', apiKey: 'tvly-1' })
  })

  it('prefers brave when both search keys are set', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      BRAVE_SEARCH_API_KEY: 'brave-1',
      TAVILY_API_KEY: 'tvly-1',
    })
    expect(result.ok && result.config.search).toEqual({ provider: 'brave', apiKey: 'brave-1' })
  })

  it('picks supermemory when SUPERMEMORY_API_KEY is set', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      SUPERMEMORY_API_KEY: 'sm-key',
    })
    expect(result.ok && result.config.memory).toEqual({ provider: 'supermemory', apiKey: 'sm-key', baseURL: undefined })
  })

  it('picks mem0 when MEM0_API_KEY is set and supermemory is not', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      MEM0_API_KEY: 'm0-key',
    })
    expect(result.ok && result.config.memory).toEqual({ provider: 'mem0', apiKey: 'm0-key' })
  })
  it('accepts the vendor spelling of the key when the base URL points at that vendor', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'or-key',
      OPENAI_MODEL: 'gpt-4o-mini',
    })
    expect(result.ok && result.config.llm.apiKey).toBe('or-key')
  })

  it('prefers the vendor key over the generic one when both are set', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'or-key',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
    })
    expect(result.ok && result.config.llm.apiKey).toBe('or-key')
  })

  it('reads any credential from its _FILE variant', () => {
    const files: Record<string, string> = {
      '/run/secrets/llm': 'sk-from-file\n',
      '/run/secrets/brave': 'brave-from-file',
      '/run/secrets/stripe': 'sk-live-from-file',
    }
    const result = loadConfigFromEnv(
      {
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_API_KEY_FILE: '/run/secrets/llm',
        OPENAI_MODEL: 'gpt-4o-mini',
        BRAVE_SEARCH_API_KEY_FILE: '/run/secrets/brave',
        HTTP_TOOL: '1',
        HTTP_SECRET_STRIPE_KEY_FILE: '/run/secrets/stripe',
      },
      (path) => files[path] ?? raiseMissing(path),
    )

    expect(result.ok && result.config.llm.apiKey).toBe('sk-from-file')
    expect(result.ok && result.config.search).toEqual({ provider: 'brave', apiKey: 'brave-from-file' })
    expect(result.ok && result.config.http.secrets).toEqual({ STRIPE_KEY: 'sk-live-from-file' })
  })

  it('names the {{PLACEHOLDER}} without the _FILE suffix', () => {
    const result = loadConfigFromEnv(
      {
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_API_KEY: 'sk-x',
        OPENAI_MODEL: 'gpt-4o-mini',
        HTTP_TOOL: '1',
        HTTP_SECRET_TOKEN_FILE: '/run/secrets/token',
      },
      () => 'ghp-1',
    )
    expect(result.ok && result.config.http.secrets).toEqual({ TOKEN: 'ghp-1' })
  })

  it('fails loudly when an optional credential file cannot be read, rather than disabling the feature', () => {
    const result = loadConfigFromEnv(
      {
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_API_KEY: 'sk-x',
        OPENAI_MODEL: 'gpt-4o-mini',
        BRAVE_SEARCH_API_KEY_FILE: '/run/secrets/typo',
      },
      (path) => raiseMissing(path),
    )
    expect(result).toEqual({ ok: false, error: expect.stringContaining('BRAVE_SEARCH_API_KEY_FILE') })
  })

  it('treats an empty key as unset, so the error names the variable instead of reaching the provider', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: '',
      OPENAI_MODEL: 'gpt-4o-mini',
    })
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/OPENAI_API_KEY/) })
  })

  it('collects every resolved secret for redaction', () => {
    const result = loadConfigFromEnv({
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_API_KEY: 'sk-x',
      OPENAI_MODEL: 'gpt-4o-mini',
      HTTP_TOOL: '1',
      HTTP_SECRET_STRIPE_KEY: 'sk-live-1',
      TAVILY_API_KEY: 'tvly-1',
      MEM0_API_KEY: 'm0-key',
    })
    expect(result.ok && [...result.config.secrets].sort()).toEqual(['m0-key', 'sk-live-1', 'sk-x', 'tvly-1'])
  })

  it('reads the file policy lists and the read-only flag', () => {
    const result = loadConfigFromEnv({
      ...base(),
      FILES_TOOL: '1',
      FILES_DENY: 'internal/**, *.bak',
      FILES_ALLOW: '.env.local',
      FILES_READONLY: '1',
    })
    expect(result.ok && result.config.files).toEqual({
      enabled: true,
      root: undefined,
      deny: ['internal/**', '*.bak'],
      allow: ['.env.local'],
      readOnly: true,
    })
  })

  it('provisions a session workspace when WORKSPACE_SESSION is set', () => {
    const result = loadConfigFromEnv({ ...base(), WORKSPACE_SESSION: '1', WORKSPACE_BASE: '/var/tmp/agents' })
    expect(result.ok && result.config.workspace).toEqual({ session: true, base: '/var/tmp/agents' })
  })
  it('leaves the shell tool off unless SHELL_TOOL is set', () => {
    const result = loadConfigFromEnv(base())
    expect(result.ok && result.config.shell.enabled).toBe(false)
  })

  it('enables the shell tool with its allowlist, env exceptions and timeout', () => {
    const result = loadConfigFromEnv({
      ...base(),
      SHELL_TOOL: '1',
      SHELL_ROOT: '/srv/workspace',
      SHELL_ALLOWED_COMMANDS: 'git, npm',
      SHELL_ALLOW_ENV: 'GH_TOKEN',
      SHELL_TIMEOUT_MS: '30000',
    })
    expect(result.ok && result.config.shell).toEqual({
      enabled: true,
      root: '/srv/workspace',
      sandbox: 'auto',
      sandboxImage: undefined,
      network: false,
      allowedCommands: ['git', 'npm'],
      allowEnv: ['GH_TOKEN'],
      timeoutMs: 30000,
    })
  })

  it('defaults the shell sandbox to auto, never to none', () => {
    const result = loadConfigFromEnv({ ...base(), SHELL_TOOL: '1' })
    expect(result.ok && result.config.shell.sandbox).toBe('auto')
  })

  it('takes an explicit sandbox backend and image', () => {
    const result = loadConfigFromEnv({
      ...base(),
      SHELL_TOOL: '1',
      SHELL_SANDBOX: 'docker',
      SHELL_SANDBOX_IMAGE: 'node:22-alpine',
      SHELL_NETWORK: '1',
    })
    expect(result.ok && result.config.shell).toMatchObject({
      sandbox: 'docker',
      sandboxImage: 'node:22-alpine',
      network: true,
    })
  })

  it('rejects an unknown sandbox rather than quietly running without one', () => {
    const result = loadConfigFromEnv({ ...base(), SHELL_TOOL: '1', SHELL_SANDBOX: 'chroot' })
    expect(result).toEqual({ ok: false, error: expect.stringContaining('SHELL_SANDBOX') })
  })
  it('falls back to FILES_ROOT so both tools share one workspace', () => {
    const result = loadConfigFromEnv({ ...base(), SHELL_TOOL: '1', FILES_ROOT: '/srv/shared' })
    expect(result.ok && result.config.shell.root).toBe('/srv/shared')
  })

  it('rejects a nonsense SHELL_TIMEOUT_MS instead of silently ignoring it', () => {
    const result = loadConfigFromEnv({ ...base(), SHELL_TOOL: '1', SHELL_TIMEOUT_MS: 'soon' })
    expect(result).toEqual({ ok: false, error: expect.stringContaining('SHELL_TIMEOUT_MS') })
  })
})

/** The three variables every config needs before anything else can be tested. */
function base(): NodeJS.ProcessEnv {
  return {
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_API_KEY: 'sk-x',
    OPENAI_MODEL: 'gpt-4o-mini',
  }
}

/** Stands in for the ENOENT a real read would throw, so error paths stay off the disk. */
function raiseMissing(path: string): never {
  throw new Error(`ENOENT: no such file or directory, open '${path}'`)
}

describe('loadConfigFromEnv with SECRET_STORE=keychain', () => {
  const base = { OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_MODEL: 'gpt-4o-mini' }
  /** A keychain holding `secrets`, recording the service it was opened with. */
  function keychain(secrets: Record<string, string>) {
    const opened: Array<string | undefined> = []
    const open: OpenKeychain = ({ service }) => {
      opened.push(service)
      return Object.assign(new MemorySecretStore(secrets), { name: 'keychain' })
    }
    return { open, opened }
  }

  it('takes a credential missing from the environment out of the keychain, and redacts it', () => {
    const { open, opened } = keychain({ OPENAI_API_KEY: 'sk-from-keychain', BRAVE_SEARCH_API_KEY: 'brave-k' })
    const result = loadConfigFromEnv({ ...base, SECRET_STORE: 'keychain' }, undefined, open)

    expect(result.ok && result.config.llm.apiKey).toBe('sk-from-keychain')
    expect(result.ok && result.config.search).toEqual({ provider: 'brave', apiKey: 'brave-k' })
    expect(result.ok && result.config.secrets).toEqual(expect.arrayContaining(['sk-from-keychain', 'brave-k']))
    expect(opened).toEqual([undefined])
  })

  it('lets a variable in the environment win over the keychain', () => {
    const { open } = keychain({ OPENAI_API_KEY: 'sk-from-keychain' })
    const result = loadConfigFromEnv({ ...base, OPENAI_API_KEY: 'sk-env', SECRET_STORE: 'keychain' }, undefined, open)
    expect(result.ok && result.config.llm.apiKey).toBe('sk-env')
  })

  it('never opens the keychain unless asked to', () => {
    const { open, opened } = keychain({ OPENAI_API_KEY: 'sk-from-keychain' })
    const result = loadConfigFromEnv({ ...base }, undefined, open)
    expect(result.ok).toBe(false)
    expect(opened).toEqual([])
  })

  it('fetches HTTP_SECRETS placeholders from the keychain under HTTP_SECRET_<NAME>', () => {
    const { open } = keychain({ OPENAI_API_KEY: 'sk', HTTP_SECRET_GITHUB_TOKEN: 'ghp-stored' })
    const result = loadConfigFromEnv(
      { ...base, SECRET_STORE: 'keychain', HTTP_TOOL: '1', HTTP_SECRETS: 'GITHUB_TOKEN, ' },
      undefined,
      open,
    )
    expect(result.ok && result.config.http.secrets).toEqual({ GITHUB_TOKEN: 'ghp-stored' })
  })

  it('fails when a named HTTP secret is in neither the environment nor the keychain', () => {
    const { open } = keychain({ OPENAI_API_KEY: 'sk' })
    const result = loadConfigFromEnv({ ...base, SECRET_STORE: 'keychain', HTTP_SECRETS: 'MISSING' }, undefined, open)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('HTTP_SECRET_MISSING') })
  })

  it('passes SECRET_STORE_SERVICE through', () => {
    const { open, opened } = keychain({ OPENAI_API_KEY: 'sk' })
    loadConfigFromEnv({ ...base, SECRET_STORE: 'keychain', SECRET_STORE_SERVICE: 'work' }, undefined, open)
    expect(opened).toEqual(['work'])
  })

  it('reports a keychain that cannot be opened or read', () => {
    const unsupported: OpenKeychain = () => {
      throw new Error('The keychain secret store supports macOS and Linux, not win32.')
    }
    expect(loadConfigFromEnv({ ...base, SECRET_STORE: 'keychain' }, undefined, unsupported)).toEqual({
      ok: false,
      error: 'SECRET_STORE=keychain: The keychain secret store supports macOS and Linux, not win32.',
    })

    const locked: OpenKeychain = () => ({
      name: 'keychain',
      get() {
        throw new Error('the Secret Service refused OPENAI_API_KEY: Cannot autolaunch D-Bus')
      },
    })
    const result = loadConfigFromEnv({ ...base, SECRET_STORE: 'keychain' }, undefined, locked)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('could not be read from the keychain') })
  })

  it('rejects an unknown SECRET_STORE rather than ignoring it', () => {
    expect(loadConfigFromEnv({ ...base, OPENAI_API_KEY: 'sk', SECRET_STORE: 'vault' })).toEqual({
      ok: false,
      error: 'SECRET_STORE must be "keychain" or "none", got "vault".',
    })
  })
})
