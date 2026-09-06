import { globToRegExp } from './filters.js'

/**
 * Per-file policy inside the workspace root.
 *
 * The root answers "which directory", and until now that was the only
 * question a file tool asked. It is the wrong granularity for the thing
 * people actually worry about: a `.env` sitting in the middle of the project
 * you want the agent to work on. `docs/security-model.md` says the model
 * never sees raw API keys, and a root-only check cannot deliver that when the
 * keys are in a file inside the root.
 *
 * A denied path is refused for reads and writes, and hidden from listings and
 * search results — a search that printed the matching line from `.env` would
 * leak the secret just as thoroughly as a read.
 *
 * The limit worth stating plainly: this binds the file tools, not the
 * machine. `run_command` can `cat .env`, because a shell command is opaque to
 * a path check. That is what the approval prompt on every command is for, and
 * ultimately #86's sandbox.
 */

export class FilePolicyError extends Error {
  override readonly name = 'FilePolicyError'
}

/**
 * Files that are secrets by convention. Chosen to be recognisable across
 * ecosystems rather than exhaustive — an operator with something unusual adds
 * it to `deny`, but nobody should have to configure `.env` by hand.
 */
export const DEFAULT_DENY: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.ssh/**',
  '.aws/credentials',
  '.kube/config',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.git/config',
  'credentials.json',
  'secrets.yaml',
  'secrets.yml',
]

/**
 * Carved back out of the defaults above. `.env.example` is a template of
 * variable *names* with the values left blank — it is checked into the repo
 * precisely so people can read it, and an agent that cannot is worse at the
 * job for no gain in safety.
 */
export const DEFAULT_ALLOW: readonly string[] = ['.env.example', '.env.sample', '.env.template', '.env.defaults']

export interface FilePolicy {
  /** Globs refused on top of `DEFAULT_DENY`. */
  deny?: readonly string[]
  /** Globs that win over a deny, including a default one. */
  allow?: readonly string[]
  /** Refuse every write, whatever the path. */
  readOnly?: boolean
  /** Drop `DEFAULT_DENY` and `DEFAULT_ALLOW`, leaving only what `deny`/`allow` say. */
  noDefaults?: boolean
}

interface Compiled {
  deny: RegExp[]
  allow: RegExp[]
  readOnly: boolean
}

/**
 * Patterns are matched against the root-relative path *and* the basename, so
 * `.env` covers `packages/api/.env` without every pattern needing a `**` in
 * front of it. A pattern that contains a slash still only ever matches the
 * path — a basename has no slashes to match against — so `.aws/credentials`
 * cannot be satisfied by a stray file called `credentials`.
 */
function matches(patterns: RegExp[], relative: string, basename: string): boolean {
  return patterns.some((pattern) => pattern.test(relative) || pattern.test(basename))
}

function compile(policy: FilePolicy): Compiled {
  const denySource = policy.noDefaults === true ? [] : DEFAULT_DENY
  const allowSource = policy.noDefaults === true ? [] : DEFAULT_ALLOW
  // Case-insensitive: a macOS or Windows filesystem will happily serve `.ENV`
  // for a file the policy knows as `.env`.
  const toRegExp = (pattern: string) => globToRegExp(pattern, false)
  return {
    deny: [...denySource, ...(policy.deny ?? [])].map(toRegExp),
    allow: [...allowSource, ...(policy.allow ?? [])].map(toRegExp),
    readOnly: policy.readOnly === true,
  }
}

/**
 * Whether a root-relative path is off-limits, `allow` overrides applied.
 * Exported for the tools that filter listings, which need the answer without
 * an exception to catch.
 */
export function isDenied(relative: string, policy: FilePolicy = {}): boolean {
  if (relative === '') return false
  const compiled = compile(policy)
  const basename = relative.slice(relative.lastIndexOf('/') + 1)
  if (matches(compiled.allow, relative, basename)) return false
  return matches(compiled.deny, relative, basename)
}

/**
 * Throws `FilePolicyError` if the path may not be accessed that way.
 *
 * The message names the path and says it is the policy talking, so the model
 * stops rather than trying ten spellings of the same file — and so the user
 * reading a transcript can tell a policy refusal from a missing file.
 */
export function checkAccess(relative: string, mode: 'read' | 'write', policy: FilePolicy = {}): void {
  if (mode === 'write' && policy.readOnly === true) {
    throw new FilePolicyError('the workspace is read-only')
  }
  if (isDenied(relative, policy)) {
    throw new FilePolicyError(`"${relative}" is excluded by the workspace file policy`)
  }
}
