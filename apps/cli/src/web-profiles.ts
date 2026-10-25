import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'
import type { ProfileAction, ProfileTool, ProfileView, ProfilesSource, ProfilesView } from '@open-agent/web'
import { editEnv } from './settings.js'
import {
  PROFILE_NAME,
  deleteProfile,
  duplicateProfile,
  listProfiles,
  loadProfile,
  parseProfile,
  validateProfile,
  writeProfile,
  type AgentProfile,
  type ProfileDirs,
} from './profiles.js'

/** The variable that names the profile every start uses when `--profile` is not given. */
export const DEFAULT_PROFILE_VAR = 'OPEN_AGENT_PROFILE'

/**
 * Tools the page can turn off in a profile but never on. The settings view
 * keeps the shell out of reach for the same reason: each hands the agent the
 * whole machine, and a page that can grant that is one stolen token away from
 * doing so. Turning them on stays with the profile file and the terminal.
 */
const RESTRICTED: ProfileTool[] = ['shell', 'computer']

export interface ProfilesDeps {
  dirs: ProfileDirs
  /** What `.env` gives with no profile applied, from the config the agent started with. */
  base: ProfilesView['base']
  /** The profile the running agent was started with, as it was named. */
  running?: string
  readEnv(): string | null
  writeEnv(content: string): void
  /** The environment before `.env` was loaded: a default set there, the page cannot change. */
  shellEnv: Readonly<Record<string, string | undefined>>
}

type Result = ReturnType<ProfilesSource['apply']>

function currentDefault(deps: ProfilesDeps): ProfilesView['defaultProfile'] {
  const fromShell = deps.shellEnv[DEFAULT_PROFILE_VAR]?.trim()
  if (fromShell) return { id: fromShell, locked: true }
  const fromFile = parse(deps.readEnv() ?? '')[DEFAULT_PROFILE_VAR]?.trim()
  return fromFile ? { id: fromFile, locked: false } : undefined
}

/** The restricted tools a profile turns on that `.env` leaves off. */
function widens(profile: AgentProfile, base: ProfilesView['base']): ProfileTool[] {
  return RESTRICTED.filter((tool) => profile.tools?.[tool] === true && !base.tools[tool])
}

/** The person's own copy of a profile, if there is one that loads: examples are not theirs to replace. */
function ownProfile(id: string, dirs: ProfileDirs): AgentProfile | undefined {
  const file = path.join(dirs.user, `${id}.yaml`)
  if (!fs.existsSync(file)) return undefined
  const parsed = parseProfile(fs.readFileSync(file, 'utf8'), file)
  return parsed.ok ? parsed.profile : undefined
}

function save(deps: ProfilesDeps, action: Extract<ProfileAction, { action: 'save' }>): Result {
  const { id, create } = action
  if (!PROFILE_NAME.test(id)) {
    return { ok: false, error: `"${id}" is not a valid profile name: use letters, digits, ".", "_" and "-".` }
  }
  const exists = fs.existsSync(path.join(deps.dirs.user, `${id}.yaml`))
  if (!create && !exists) {
    return { ok: false, error: `"${id}" is not one of your profiles. Examples are read-only here: duplicate one.` }
  }
  const validated = validateProfile(
    { name: action.profile.name.trim(), model: action.profile.model.trim(), tools: action.profile.tools },
    `"${id}"`,
  )
  if (!validated.ok) return validated
  const profile = validated.profile
  if (Object.keys(profile.tools ?? {}).length === 0) delete profile.tools

  // A restricted tool already on in the stored file may stay on — editing the
  // model must not mean losing it — but the page cannot be what turns it on.
  const before = create ? undefined : ownProfile(id, deps.dirs)
  const added = widens(profile, deps.base).filter((tool) => before?.tools?.[tool] !== true)
  if (added.length > 0) {
    return {
      ok: false,
      error: `${added.join(' and ')} cannot be turned on from the page. Edit ${path.join(deps.dirs.user, `${id}.yaml`)}, or turn it on in .env with open-agent init.`,
    }
  }

  const written = writeProfile(deps.dirs, id, profile, { replace: !create })
  if (!written.ok) return written
  return { ok: true, restartNeeded: id === deps.running || id === currentDefault(deps)?.id }
}

function setDefault(deps: ProfilesDeps, id: string | null): Result {
  const current = currentDefault(deps)
  if (current?.locked) {
    return {
      ok: false,
      error: `${DEFAULT_PROFILE_VAR} is set in the environment the agent was started from, which .env cannot override. Change it there.`,
    }
  }
  if (id !== null) {
    if (!PROFILE_NAME.test(id)) return { ok: false, error: `"${id}" is not a valid profile name.` }
    const loaded = loadProfile(id, deps.dirs)
    if (!loaded.ok) return loaded
    // A default applies to every start, with nobody at the terminal choosing
    // it: it may not turn on what .env leaves off.
    const widened = widens(loaded.profile, deps.base)
    if (widened.length > 0) {
      return {
        ok: false,
        error: `"${id}" turns on ${widened.join(' and ')}, which .env leaves off, so it cannot be the default. Start it from the terminal with --profile ${id}.`,
      }
    }
  }
  deps.writeEnv(
    editEnv(
      deps.readEnv() ?? '# Written by the open-agent web UI. Every setting is described in .env.example.\n',
      new Map([[DEFAULT_PROFILE_VAR, id]]),
    ),
  )
  return { ok: true, restartNeeded: (id ?? undefined) !== deps.running }
}

/** The profiles view's access to the profile folders and to the default in `.env`. */
export function profilesSource(deps: ProfilesDeps): ProfilesSource {
  return {
    read: () => ({
      dir: deps.dirs.user,
      base: deps.base,
      restricted: RESTRICTED,
      ...(deps.running !== undefined ? { running: deps.running } : {}),
      ...(currentDefault(deps) ? { defaultProfile: currentDefault(deps) } : {}),
      profiles: listProfiles(deps.dirs).map((listed): ProfileView =>
        listed.profile
          ? {
              id: listed.id,
              origin: listed.origin,
              name: listed.profile.name,
              model: listed.profile.model,
              tools: listed.profile.tools ?? {},
            }
          : { id: listed.id, origin: listed.origin, name: listed.id, model: '', tools: {}, error: listed.error },
      ),
    }),
    apply(action) {
      switch (action.action) {
        case 'save':
          return save(deps, action)
        case 'duplicate': {
          if (!PROFILE_NAME.test(action.id)) return { ok: false, error: `"${action.id}" is not a valid profile name.` }
          // A copy reaches no further than the profile it was made from, and
          // using it still takes --profile or the default, which checks it.
          const copied = duplicateProfile(action.id, action.newId, deps.dirs)
          return copied.ok ? { ok: true, restartNeeded: false } : copied
        }
        case 'delete': {
          if (action.id === currentDefault(deps)?.id) {
            return { ok: false, error: `"${action.id}" is the default profile. Clear the default first.` }
          }
          const removed = deleteProfile(action.id, deps.dirs)
          return removed.ok ? { ok: true, restartNeeded: false } : removed
        }
        case 'default':
          return setDefault(deps, action.id)
      }
    },
  }
}
