import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PROFILE_ENV_VARS, createBrowserProfile, profileEnv } from './profile.js'

let base: string

const exists = async (target: string) => {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-base-'))
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe('createBrowserProfile', () => {
  it('provisions a fresh directory under the base', async () => {
    const profile = await createBrowserProfile({ base })
    expect(profile.dir.startsWith(base)).toBe(true)
    expect(await exists(profile.dir)).toBe(true)
    expect(profile.shared).toBe(false)
  })

  it('starts empty, so a visited page finds no cookies or history', async () => {
    const profile = await createBrowserProfile({ base })
    expect(await fs.readdir(profile.dir)).toEqual([])
  })

  it('gives two runs different profiles', async () => {
    const first = await createBrowserProfile({ base })
    const second = await createBrowserProfile({ base })
    expect(first.dir).not.toBe(second.dir)
  })

  it('removes a provisioned profile on dispose', async () => {
    const profile = await createBrowserProfile({ base })
    await fs.writeFile(path.join(profile.dir, 'Cookies'), 'session=abc')
    await profile.dispose()
    expect(await exists(profile.dir)).toBe(false)
  })

  it('keeps a provisioned profile when asked, for inspecting what was stored', async () => {
    const profile = await createBrowserProfile({ base, keep: true })
    await profile.dispose()
    expect(await exists(profile.dir)).toBe(true)
  })

  it('adopts a named directory and marks it shared', async () => {
    const mine = path.join(base, 'my-real-chrome-profile')
    await fs.mkdir(mine)
    const profile = await createBrowserProfile({ dir: mine })
    expect(profile.dir).toBe(mine)
    expect(profile.shared).toBe(true)
  })

  it('never deletes a shared profile, whatever dispose is asked', async () => {
    // It is the user's directory, named by the user. Removing it on exit
    // would take their real browser state with it.
    const mine = path.join(base, 'my-real-chrome-profile')
    await fs.mkdir(mine)
    await fs.writeFile(path.join(mine, 'Cookies'), 'session=abc')

    const profile = await createBrowserProfile({ dir: mine })
    await profile.dispose()

    expect(await exists(path.join(mine, 'Cookies'))).toBe(true)
  })

  it('creates a named directory that does not exist yet', async () => {
    const profile = await createBrowserProfile({ dir: path.join(base, 'new-one') })
    expect(await exists(profile.dir)).toBe(true)
  })
})

describe('profileEnv', () => {
  it('points every known variable at the profile', async () => {
    const profile = await createBrowserProfile({ base })
    const env = profileEnv(profile)
    expect(Object.keys(env)).toEqual([...DEFAULT_PROFILE_ENV_VARS])
    expect(new Set(Object.values(env))).toEqual(new Set([profile.dir]))
  })

  it('takes an explicit list, for a browser-use that reads a different name', async () => {
    const profile = await createBrowserProfile({ base })
    expect(profileEnv(profile, ['SOME_OTHER_DIR'])).toEqual({ SOME_OTHER_DIR: profile.dir })
  })
})
