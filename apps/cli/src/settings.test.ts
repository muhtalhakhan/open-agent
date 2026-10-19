import { describe, expect, it } from 'vitest'
import { loadConfigFromEnv } from './config.js'
import { applySettings, readSettings, type SettingsDeps } from './settings.js'

/** A `.env` in a string, an optional fake keychain, and startup's own validation. */
function setup({
  env = '',
  shell = {},
  keychain,
}: {
  env?: string | null
  shell?: Record<string, string>
  keychain?: Record<string, string>
} = {}) {
  const state = { env, writes: 0 }
  const stored = keychain ? new Map(Object.entries(keychain)) : undefined
  const deps: SettingsDeps = {
    envPath: '/project/.env',
    readEnv: () => state.env,
    writeEnv: (content) => {
      state.env = content
      state.writes++
    },
    shellEnv: shell,
    ...(stored
      ? {
          keychain: {
            name: 'keychain',
            get: (key: string) => stored.get(key),
            set: (key: string, value: string) => void stored.set(key, value),
          },
        }
      : {}),
    validate: (environment) => {
      const result = loadConfigFromEnv(environment, undefined, () => ({
        name: 'keychain',
        get: (key: string) => stored?.get(key),
      }))
      return result.ok ? undefined : result.error
    },
  }
  return { deps, state, stored }
}

const working = 'OPENAI_BASE_URL=https://api.openai.com/v1\nOPENAI_MODEL=gpt-4o-mini\nOPENAI_API_KEY=sk-old\n'
const setting = (groups: ReturnType<typeof readSettings>, name: string) =>
  groups.flatMap((group) => group.settings).find((s) => s.name === name)!

describe('readSettings', () => {
  it('shows values and where each comes from, but never a secret', () => {
    const { deps } = setup({
      env: `${working}BROWSER_USE=1\n`,
      shell: { OPENAI_MODEL_LIGHT: 'gpt-small' },
      keychain: { TAVILY_API_KEY: 'tvly-secret' },
    })

    const groups = readSettings(deps)

    expect(setting(groups, 'OPENAI_MODEL')).toMatchObject({ value: 'gpt-4o-mini', source: 'env-file' })
    expect(setting(groups, 'OPENAI_MODEL_LIGHT')).toMatchObject({ value: 'gpt-small', source: 'shell' })
    expect(setting(groups, 'OPENAI_API_KEY')).toMatchObject({ source: 'env-file' })
    expect(setting(groups, 'TAVILY_API_KEY')).toMatchObject({ source: 'keychain' })
    expect(setting(groups, 'MEM0_API_KEY')).toMatchObject({ source: 'unset' })
    expect(JSON.stringify(groups)).not.toMatch(/sk-old|tvly-secret/)
  })

  it('reports the model key under the vendor name the config reads first', () => {
    const { deps } = setup({ env: 'OPENAI_BASE_URL=https://api.anthropic.com/v1\nANTHROPIC_API_KEY=sk-ant\n' })

    expect(setting(readSettings(deps), 'OPENAI_API_KEY').source).toBe('env-file')
  })
})

describe('applySettings', () => {
  it('edits .env in place, keeping comments and settings it does not manage', () => {
    const { deps, state } = setup({ env: `# mine\n${working}FILES_TOOL=1\n` })

    const result = applySettings(deps, { OPENAI_MODEL: 'gpt-5', BROWSER_USE: '1' })

    expect(result).toEqual({ ok: true })
    expect(state.env).toBe(
      '# mine\nOPENAI_BASE_URL=https://api.openai.com/v1\nOPENAI_MODEL=gpt-5\nOPENAI_API_KEY=sk-old\nFILES_TOOL=1\nBROWSER_USE=1\n',
    )
  })

  it('removes a setting given null, and a later duplicate that would override the edit', () => {
    const { deps, state } = setup({ env: `${working}TAVILY_API_KEY=a\nTAVILY_API_KEY=b\n` })

    applySettings(deps, { TAVILY_API_KEY: null })

    expect(state.env).not.toContain('TAVILY_API_KEY')
  })

  it('puts a new key in the keychain when one is configured, and takes it out of .env', () => {
    const { deps, state, stored } = setup({
      env: `${working}SECRET_STORE=keychain\nBRAVE_SEARCH_API_KEY=old\n`,
      keychain: {},
    })

    expect(applySettings(deps, { BRAVE_SEARCH_API_KEY: 'brave-new' })).toEqual({ ok: true })

    expect(stored?.get('BRAVE_SEARCH_API_KEY')).toBe('brave-new')
    expect(state.env).not.toContain('BRAVE_SEARCH_API_KEY')
  })

  it('writes the model key to the variable the config will read for the base URL being saved', () => {
    // Only the generic name is set: that is what the config falls back to, so it is the one to replace.
    const generic = setup({ env: working })
    applySettings(generic.deps, { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1', OPENAI_API_KEY: 'sk-or' })
    expect(generic.state.env).toContain('OPENAI_API_KEY=sk-or')

    // The vendor's own name is set and read first: writing the generic one would save a key nothing reads.
    const vendor = setup({ env: `${working}OPENROUTER_API_KEY=sk-or-old\n` })
    applySettings(vendor.deps, { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1', OPENAI_API_KEY: 'sk-or-new' })
    expect(vendor.state.env).toContain('OPENROUTER_API_KEY=sk-or-new')
    expect(vendor.state.env).toContain('OPENAI_API_KEY=sk-old')
  })

  it('refuses a change that would stop the agent starting, and writes nothing', () => {
    const { deps, state } = setup({ env: `${working}TYPESAFE_API_KEY=ts\n` })

    const result = applySettings(deps, { DECISION_LAYER: 'route' })

    expect(result).toEqual({ ok: false, error: expect.stringContaining('OPENAI_MODEL_LIGHT') })
    expect(state.writes).toBe(0)
  })

  it('refuses names it does not manage, bad values, and anything set in the shell', () => {
    const { deps, state } = setup({ env: working, shell: { OPENAI_MODEL: 'from-shell' } })

    const refusals = [
      applySettings(deps, { SHELL_SANDBOX: 'none' }),
      applySettings(deps, { OPENAI_BASE_URL: 'file:///etc/passwd' }),
      applySettings(deps, { BRAVE_SEARCH_API_KEY: 'a\nSHELL_TOOL=1' }),
      applySettings(deps, { BROWSER_USE: 'yes' }),
      applySettings(deps, { OPENAI_MODEL: 'other' }),
    ]

    expect(refusals.map((r) => r.ok)).toEqual([false, false, false, false, false])
    expect(refusals[0]).toMatchObject({ error: expect.stringContaining('cannot be changed here') })
    expect(refusals[4]).toMatchObject({ error: expect.stringContaining('environment the agent was started from') })
    expect(state.writes).toBe(0)
  })

  it('cannot remove a key that lives only in the keychain, and says where it is', () => {
    const { deps } = setup({ env: `${working}SECRET_STORE=keychain\n`, keychain: { MEM0_API_KEY: 'm0' } })

    expect(applySettings(deps, { MEM0_API_KEY: null })).toEqual({
      ok: false,
      error: expect.stringContaining('remove it with your keychain tool'),
    })
  })

  it('creates .env when there is none, as long as the result would start', () => {
    const { deps, state } = setup({ env: null })

    expect(applySettings(deps, { OPENAI_MODEL: 'gpt-4o-mini' }).ok).toBe(false)
    expect(
      applySettings(deps, {
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_MODEL: 'gpt-4o-mini',
        OPENAI_API_KEY: 'sk-new',
      }),
    ).toEqual({ ok: true })
    expect(state.env).toContain('OPENAI_API_KEY=sk-new')
  })
})
