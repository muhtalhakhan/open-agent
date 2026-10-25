import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfigFromEnv, type CliConfig } from './config.js'
import {
  applyProfile,
  deleteProfile,
  duplicateProfile,
  exportProfile,
  importProfile,
  listProfiles,
  loadProfile,
  parseProfile,
  writeProfile,
  type ProfileDirs,
} from './profiles.js'

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

describe('duplicate, export and import', () => {
  let tmp: string
  let dirs: ProfileDirs

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-profiles-'))
    // The user folder doesn't exist yet: writing the first profile creates it.
    dirs = { user: path.join(tmp, 'home', 'profiles'), examples: path.join(tmp, 'examples') }
    fs.mkdirSync(dirs.examples)
    fs.writeFileSync(path.join(dirs.examples, 'coder.yaml'), 'name: Coder\nmodel: m\ntools:\n  shell: true\n')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const write = (name: string, content: string) => {
    const file = path.join(tmp, name)
    fs.writeFileSync(file, content)
    return file
  }

  it('round-trips: export, import elsewhere, load the same profile back', () => {
    const exported = exportProfile('coder', dirs)
    if (!exported.ok) throw new Error(exported.error)
    const imported = importProfile(write('shared.yaml', exported.yaml), dirs)
    expect(imported).toMatchObject({ ok: true, file: path.join(dirs.user, 'shared.yaml') })
    expect(loadProfile('shared', dirs)).toEqual({
      ok: true,
      profile: { name: 'Coder', model: 'm', tools: { shell: true } },
    })
  })

  it('duplicates under the new name, renaming the copy', () => {
    expect(duplicateProfile('coder', 'my-coder', dirs)).toMatchObject({ ok: true, profile: { name: 'my-coder' } })
    expect(loadProfile('my-coder', dirs)).toMatchObject({ ok: true, profile: { model: 'm', tools: { shell: true } } })
  })

  it.each([
    ['name', 'model: m\n', /needs a "name"/],
    ['model', 'name: N\n', /needs a "model"/],
  ])('refuses to import a profile missing its %s', (_, content, error) => {
    const result = importProfile(write('partial.yaml', content), dirs)
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(error) })
    expect(fs.existsSync(dirs.user)).toBe(false)
  })

  it('places an import by its file name, never by the name inside it', () => {
    const result = importProfile(write('innocent.yaml', 'name: ../../escaped\nmodel: m\n'), dirs)
    expect(result).toMatchObject({ ok: true, file: path.join(dirs.user, 'innocent.yaml') })
    expect(fs.existsSync(path.join(tmp, 'escaped.yaml'))).toBe(false)
  })

  it.each(['../escaped', '..', '.hidden', 'a/b', ''])('refuses %j as a duplicate name', (name) => {
    expect(duplicateProfile('coder', name, dirs)).toMatchObject({ ok: false })
    expect(fs.existsSync(path.join(tmp, 'escaped.yaml'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'home', 'escaped.yaml'))).toBe(false)
  })

  it('refuses to import a file whose name is not a valid profile name', () => {
    expect(importProfile(write('.hidden.yaml', 'name: N\nmodel: m\n'), dirs)).toMatchObject({ ok: false })
  })

  it('never overwrites an existing profile', () => {
    expect(duplicateProfile('coder', 'mine', dirs).ok).toBe(true)
    fs.writeFileSync(path.join(dirs.user, 'mine.yaml'), 'name: Edited\nmodel: m\n')

    expect(duplicateProfile('coder', 'mine', dirs)).toMatchObject({ ok: false, error: expect.stringMatching(/exists/) })
    expect(importProfile(write('mine.yaml', 'name: Theirs\nmodel: m\n'), dirs)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/exists/),
    })
    expect(loadProfile('mine', dirs)).toMatchObject({ ok: true, profile: { name: 'Edited' } })
  })

  it('reports a missing import file without throwing', () => {
    expect(importProfile(path.join(tmp, 'gone.yaml'), dirs)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not found/),
    })
  })
})

describe('list, replace and delete', () => {
  let tmp: string
  let dirs: ProfileDirs

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-profiles-'))
    dirs = { user: path.join(tmp, 'home', 'profiles'), examples: path.join(tmp, 'examples') }
    fs.mkdirSync(dirs.examples)
    fs.writeFileSync(path.join(dirs.examples, 'coder.yaml'), 'name: Coder\nmodel: m\n')
    fs.writeFileSync(path.join(dirs.examples, 'writer.yaml'), 'name: Writer\nmodel: w\n')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('lists your profiles, then the examples none of them shadows, with files that do not load', () => {
    expect(listProfiles(dirs).map(({ id, origin }) => `${origin}:${id}`)).toEqual(['example:coder', 'example:writer'])

    fs.mkdirSync(dirs.user, { recursive: true })
    fs.writeFileSync(path.join(dirs.user, 'coder.yaml'), 'name: My coder\nmodel: mine\n')
    fs.writeFileSync(path.join(dirs.user, 'broken.yaml'), 'name: B\n')
    fs.writeFileSync(path.join(dirs.user, 'notes.txt'), 'not a profile')

    const listed = listProfiles(dirs)
    expect(listed.map(({ id, origin }) => `${origin}:${id}`)).toEqual(['user:broken', 'user:coder', 'example:writer'])
    expect(listed[0]).toMatchObject({ error: expect.stringMatching(/needs a "model"/) })
    expect(listed[1]).toMatchObject({ profile: { name: 'My coder', model: 'mine' } })
  })

  it('replaces an existing profile only when asked to', () => {
    expect(writeProfile(dirs, 'mine', { name: 'One', model: 'm' }).ok).toBe(true)
    expect(writeProfile(dirs, 'mine', { name: 'Two', model: 'm' })).toMatchObject({ ok: false })
    expect(writeProfile(dirs, 'mine', { name: 'Two', model: 'm' }, { replace: true }).ok).toBe(true)
    expect(loadProfile('mine', dirs)).toMatchObject({ ok: true, profile: { name: 'Two' } })
  })

  it('deletes your own profiles, and never an example or a path', () => {
    writeProfile(dirs, 'mine', { name: 'Mine', model: 'm' })

    expect(deleteProfile('mine', dirs)).toEqual({ ok: true })
    expect(deleteProfile('coder', dirs)).toMatchObject({ ok: false, error: expect.stringMatching(/not one of your/) })
    expect(deleteProfile('../examples/coder', dirs)).toMatchObject({ ok: false })
    expect(fs.existsSync(path.join(dirs.examples, 'coder.yaml'))).toBe(true)
  })
})
