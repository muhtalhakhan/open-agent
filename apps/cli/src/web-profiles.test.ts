import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProfileFields } from '@open-agent/web'
import { loadProfile, type ProfileDirs } from './profiles.js'
import { profilesSource, type ProfilesDeps } from './web-profiles.js'

const OFF = { browser: false, computer: false, http: false, files: false, shell: false }

describe('profilesSource', () => {
  let tmp: string
  let dirs: ProfileDirs
  let env: string | null

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-web-profiles-'))
    dirs = { user: path.join(tmp, 'home', 'profiles'), examples: path.join(tmp, 'examples') }
    fs.mkdirSync(dirs.examples)
    fs.writeFileSync(path.join(dirs.examples, 'coder.yaml'), 'name: Coder\nmodel: m\ntools:\n  shell: true\n')
    fs.writeFileSync(path.join(dirs.examples, 'reader.yaml'), 'name: Reader\nmodel: r\ntools:\n  files: true\n')
    env = '# mine\nOPENAI_MODEL=base\n'
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const source = (overrides: Partial<ProfilesDeps> = {}) =>
    profilesSource({
      dirs,
      base: { model: 'base', tools: { ...OFF, files: true } },
      readEnv: () => env,
      writeEnv: (content) => (env = content),
      shellEnv: {},
      ...overrides,
    })
  const fields = (tools: ProfileFields['tools'] = {}): ProfileFields => ({ name: 'Mine', model: 'm', tools })

  it('creates a profile and edits it in place, which needs a restart only when it is in use', () => {
    const s = source({ running: 'mine' })

    expect(s.apply({ action: 'save', id: 'other', create: true, profile: fields() })).toEqual({
      ok: true,
      restartNeeded: false,
    })
    expect(s.apply({ action: 'save', id: 'mine', create: true, profile: fields({ http: true }) })).toEqual({
      ok: true,
      restartNeeded: true,
    })
    expect(s.apply({ action: 'save', id: 'mine', create: true, profile: fields() })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/exists/),
    })
    expect(s.apply({ action: 'save', id: 'mine', create: false, profile: { ...fields(), model: 'm2' } }).ok).toBe(true)

    expect(loadProfile('mine', dirs)).toEqual({ ok: true, profile: { name: 'Mine', model: 'm2' } })
    expect(s.read().profiles.map((p) => `${p.origin}:${p.id}`)).toEqual([
      'user:mine',
      'user:other',
      'example:coder',
      'example:reader',
    ])
  })

  it('treats the examples as read-only', () => {
    expect(source().apply({ action: 'save', id: 'reader', create: false, profile: fields() })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/read-only/),
    })
    expect(source().apply({ action: 'delete', id: 'reader' })).toMatchObject({ ok: false })
  })

  it('refuses a profile it cannot validate, and a file name that could leave the folder', () => {
    const s = source()

    expect(s.apply({ action: 'save', id: 'x', create: true, profile: { ...fields(), model: ' ' } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/needs a "model"/),
    })
    expect(
      s.apply({ action: 'save', id: 'x', create: true, profile: fields({ sudo: true } as ProfileFields['tools']) }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/unknown tool/) })
    expect(s.apply({ action: 'save', id: '../escaped', create: true, profile: fields() })).toMatchObject({ ok: false })
    expect(fs.existsSync(path.join(tmp, 'home', 'escaped.yaml'))).toBe(false)
  })

  describe('the shell and computer tools', () => {
    it('can be turned off from the page, never on', () => {
      const s = source()

      expect(s.apply({ action: 'save', id: 'safe', create: true, profile: fields({ shell: false }) }).ok).toBe(true)
      expect(s.apply({ action: 'save', id: 'safe', create: false, profile: fields({ shell: true }) })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/shell cannot be turned on from the page/),
      })
      expect(
        s.apply({ action: 'save', id: 'new', create: true, profile: fields({ computer: true, shell: true }) }),
      ).toMatchObject({ ok: false, error: expect.stringMatching(/shell and computer/) })
      expect(fs.existsSync(path.join(dirs.user, 'new.yaml'))).toBe(false)
    })

    it('stay on when the stored profile already had them on', () => {
      const s = source()
      expect(s.apply({ action: 'duplicate', id: 'coder', newId: 'my-coder' }).ok).toBe(true)

      expect(
        s.apply({ action: 'save', id: 'my-coder', create: false, profile: fields({ shell: true, http: true }) }),
      ).toMatchObject({ ok: true })
      expect(loadProfile('my-coder', dirs)).toMatchObject({ ok: true, profile: { tools: { shell: true, http: true } } })
    })

    it('may be turned on when .env already has them on', () => {
      const s = source({ base: { model: 'base', tools: { ...OFF, shell: true } } })

      expect(s.apply({ action: 'save', id: 'sh', create: true, profile: fields({ shell: true }) }).ok).toBe(true)
    })
  })

  describe('the default profile', () => {
    it('is saved to .env, keeping what else is there, and cleared again', () => {
      const s = source()

      expect(s.apply({ action: 'default', id: 'reader' })).toEqual({ ok: true, restartNeeded: true })
      expect(env).toBe('# mine\nOPENAI_MODEL=base\nOPEN_AGENT_PROFILE=reader\n')
      expect(s.read().defaultProfile).toEqual({ id: 'reader', locked: false })

      expect(s.apply({ action: 'default', id: null })).toEqual({ ok: true, restartNeeded: false })
      expect(env).toBe('# mine\nOPENAI_MODEL=base\n')
      expect(s.read().defaultProfile).toBeUndefined()
    })

    it('cannot be a profile that turns on the shell or computer tools .env leaves off', () => {
      expect(source().apply({ action: 'default', id: 'coder' })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/--profile coder/),
      })
      expect(env).not.toContain('OPEN_AGENT_PROFILE')
    })

    it('cannot be a profile that does not exist', () => {
      expect(source().apply({ action: 'default', id: 'nope' })).toMatchObject({ ok: false })
    })

    it('is left alone when the shell sets it', () => {
      const s = source({ shellEnv: { OPEN_AGENT_PROFILE: 'reader' } })

      expect(s.read().defaultProfile).toEqual({ id: 'reader', locked: true })
      expect(s.apply({ action: 'default', id: null })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/environment/),
      })
    })

    it('cannot be deleted until it is cleared', () => {
      const s = source()
      s.apply({ action: 'save', id: 'mine', create: true, profile: fields() })
      s.apply({ action: 'default', id: 'mine' })

      expect(s.apply({ action: 'delete', id: 'mine' })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/Clear the default first/),
      })
      expect(s.apply({ action: 'save', id: 'mine', create: false, profile: fields() })).toEqual({
        ok: true,
        restartNeeded: true,
      })
    })
  })
})
