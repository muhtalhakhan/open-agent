import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfigFromEnv, type CliConfig } from './config.js'
import { applyProfile, loadProfile, parseProfile, type ProfileDirs } from './profiles.js'

function baseConfig(env: Record<string, string> = {}): CliConfig {
  const result = loadConfigFromEnv({
    OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENAI_API_KEY: 'sk-x',
    OPENAI_MODEL: 'env-model',
    ...env,
  })
  if (!result.ok) throw new Error(result.error)
  return result.config
}

describe('parseProfile', () => {
  it('accepts a name, a model and tool switches', () => {
    expect(parseProfile('name: Coder\nmodel: m\ntools:\n  shell: true\n  browser: false\n', 'p.yaml')).toEqual({
      ok: true,
      profile: { name: 'Coder', model: 'm', tools: { shell: true, browser: false } },
    })
  })

  it.each([
    ['a missing name', 'model: m\n', /needs a "name"/],
    ['a missing model', 'name: N\n', /needs a "model"/],
    ['a non-string model', 'name: N\nmodel: 42\n', /needs a "model"/],
    ['a list instead of a mapping', '- a\n- b\n', /must be a YAML mapping/],
    ['tools that are not a mapping', 'name: N\nmodel: m\ntools: yes\n', /"tools" must be a mapping/],
    ['a tool switch that is not a boolean', 'name: N\nmodel: m\ntools:\n  shell: "yes"\n', /tools.shell must be/],
    ['a tool the config has no switch for', 'name: N\nmodel: m\ntools:\n  docker: true\n', /unknown tool "docker"/],
    ['permissions', 'name: N\nmodel: m\npermissions:\n  terminal.execute: safe\n', /unsupported fields: permissions/],
    ['memory', 'name: N\nmodel: m\nmemory: true\n', /unsupported fields: memory/],
    ['broken YAML', 'name: [unclosed\n', /not valid YAML/],
  ])('rejects %s', (_, content, error) => {
    const result = parseProfile(content, 'p.yaml')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(error)
  })
})

describe('loadProfile', () => {
  let tmp: string
  let dirs: ProfileDirs

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-profiles-'))
    dirs = { user: path.join(tmp, 'home'), examples: path.join(tmp, 'examples') }
    fs.mkdirSync(dirs.user)
    fs.mkdirSync(dirs.examples)
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('finds a name in the user folder before the examples', () => {
    fs.writeFileSync(path.join(dirs.user, 'coder.yaml'), 'name: Mine\nmodel: m\n')
    fs.writeFileSync(path.join(dirs.examples, 'coder.yaml'), 'name: Example\nmodel: m\n')
    expect(loadProfile('coder', dirs)).toMatchObject({ ok: true, profile: { name: 'Mine' } })
  })

  it('falls back to the examples', () => {
    fs.writeFileSync(path.join(dirs.examples, 'coder.yaml'), 'name: Example\nmodel: m\n')
    expect(loadProfile('coder', dirs)).toMatchObject({ ok: true, profile: { name: 'Example' } })
  })

  it('loads a path as given', () => {
    const file = path.join(tmp, 'elsewhere.yaml')
    fs.writeFileSync(file, 'name: There\nmodel: m\n')
    expect(loadProfile(file, dirs)).toMatchObject({ ok: true, profile: { name: 'There' } })
  })

  it('reports a name that is in neither folder', () => {
    expect(loadProfile('nope', dirs)).toMatchObject({ ok: false, error: expect.stringMatching(/not found/) })
  })

  it('reports a missing path without throwing', () => {
    expect(loadProfile(path.join(tmp, 'gone.yaml'), dirs)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not found/),
    })
  })

  it('refuses a name starting with a dot', () => {
    expect(loadProfile('.hidden', dirs)).toMatchObject({ ok: false, error: expect.stringMatching(/not a valid/) })
  })
})

describe('applyProfile', () => {
  it('replaces the model and keeps the rest of the llm config', () => {
    const config = applyProfile(baseConfig(), { name: 'N', model: 'profile-model' })
    expect(config.llm).toMatchObject({ model: 'profile-model', apiKey: 'sk-x' })
  })

  it('wins over .env for every tool it sets, in both directions', () => {
    const config = applyProfile(baseConfig({ SHELL_TOOL: '1', BROWSER_USE: '1' }), {
      name: 'N',
      model: 'm',
      tools: { shell: false, files: true },
    })
    expect(config.shell.enabled).toBe(false)
    expect(config.files.enabled).toBe(true)
    // Not set by the profile, so .env's value stands.
    expect(config.browser.enabled).toBe(true)
  })

  it("keeps a tool's other settings when switching it", () => {
    const before = baseConfig({ SHELL_TOOL: '1', SHELL_SANDBOX: 'none' })
    const config = applyProfile(before, { name: 'N', model: 'm', tools: { shell: false } })
    expect(config.shell).toEqual({ ...before.shell, enabled: false })
  })

  it('does not change the config it was given', () => {
    const before = baseConfig({ SHELL_TOOL: '1' })
    applyProfile(before, { name: 'N', model: 'm', tools: { shell: false } })
    expect(before.shell.enabled).toBe(true)
    expect(before.llm.model).toBe('env-model')
  })
})

describe('the example profiles', () => {
  const examples = path.resolve(import.meta.dirname, '../../../examples/profiles')

  it.each(fs.readdirSync(examples))('%s parses', (file) => {
    expect(parseProfile(fs.readFileSync(path.join(examples, file), 'utf8'), file).ok).toBe(true)
  })
})
