import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Where the agent's browser keeps its profile.
 *
 * `docs/security-model.md` asks for "a dedicated, isolated browser profile —
 * not the user's real logged-in browser — unless the user explicitly
 * configures profile sharing". The reason is worth stating: a browser started
 * against your everyday profile is a browser already logged into your email,
 * your bank and your source control, and every one of those sessions is
 * reachable by a page the agent visits and by any instruction hidden in it.
 * Sharing the profile is a coherent thing to want — some tasks need a
 * logged-in session — but it should be a sentence someone wrote, not the
 * default they got.
 */

export interface BrowserProfile {
  /** Absolute path the browser should use as its user-data directory. */
  dir: string
  /** True when this is the user's own profile rather than one we made. */
  shared: boolean
  /** Removes the directory, for a profile we provisioned. A shared one is left alone. */
  dispose(): Promise<void>
}

export interface ProfileOptions {
  /**
   * Use this directory as-is. Naming the user's real profile here is how
   * sharing is opted into — hence `shared: true` on the result, so callers
   * can say so out loud.
   */
  dir?: string
  /** Directory to provision a throwaway profile under (default: the OS temp dir). */
  base?: string
  /** Keep the provisioned directory on dispose, to inspect what the browser stored. */
  keep?: boolean
}

/**
 * Provisions a fresh profile directory, or adopts the one it was given.
 *
 * A provisioned profile starts empty every run: no cookies, no saved
 * passwords, no history, nothing for a visited page to reach. It is removed
 * afterwards unless `keep` says otherwise.
 */
export async function createBrowserProfile(options: ProfileOptions = {}): Promise<BrowserProfile> {
  if (options.dir) {
    const dir = path.resolve(options.dir)
    await fs.mkdir(dir, { recursive: true })
    return {
      dir,
      shared: true,
      async dispose() {
        // Never: this is the user's directory, named by the user.
      },
    }
  }

  const base = options.base ?? os.tmpdir()
  const dir = path.join(base, `open-agent-browser-${randomBytes(6).toString('hex')}`)
  await fs.mkdir(dir, { recursive: true })

  return {
    dir,
    shared: false,
    async dispose() {
      if (options.keep === true) return
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Environment variables telling browser-use where the profile lives.
 *
 * The names belong to browser-use, not to us, which is why they are data here
 * and overridable in `BrowserUseOptions.profileEnvVars` rather than baked into
 * the spawn call. If a future browser-use renames them, that is a one-line
 * config change for an operator instead of a patch release from us. Several
 * spellings are set at once for the same reason: they cost nothing, and
 * setting the one that stopped being read is a silent failure.
 */
export const DEFAULT_PROFILE_ENV_VARS: readonly string[] = [
  'BROWSER_USE_USER_DATA_DIR',
  'CHROME_USER_DATA_DIR',
  'PLAYWRIGHT_USER_DATA_DIR',
]

/** The env entries that point browser-use at `profile`. */
export function profileEnv(
  profile: BrowserProfile,
  vars: readonly string[] = DEFAULT_PROFILE_ENV_VARS,
): Record<string, string> {
  return Object.fromEntries(vars.map((name) => [name, profile.dir]))
}
