/**
 * What a subprocess the agent starts is allowed to see of the agent's own
 * environment.
 *
 * The agent's environment is where every API key it was configured with
 * lives. Anything it spawns — a shell command, an MCP server, a browser
 * driver — inherits that by default, which quietly contradicts the promise in
 * docs/security-model.md that the model never sees raw API keys: a subprocess
 * that can read them can print them, and anything printed comes back as tool
 * output.
 *
 * Lives here rather than in one tool package because more than one needs it
 * and the rule should not be allowed to drift between them. This is the
 * package that already owns the permission model.
 */

/** Names that look like a credential. */
const CREDENTIAL_NAME = /(^|_)(api[_-]?key|token|secret|password|passwd|credentials?|auth)($|_)/i

/**
 * Strips credential-looking variables from an environment.
 *
 * `keep` names the exceptions — a subprocess that genuinely needs `GH_TOKEN`
 * can have it, by the operator's decision rather than the model's.
 */
export function filterEnv(
  env: NodeJS.ProcessEnv,
  keep: readonly string[] = [],
): { env: NodeJS.ProcessEnv; removed: string[] } {
  const kept = new Set(keep)
  const filtered: NodeJS.ProcessEnv = {}
  const removed: string[] = []

  for (const [name, value] of Object.entries(env)) {
    if (!kept.has(name) && CREDENTIAL_NAME.test(name)) {
      removed.push(name)
      continue
    }
    filtered[name] = value
  }

  return { env: filtered, removed: removed.sort() }
}
