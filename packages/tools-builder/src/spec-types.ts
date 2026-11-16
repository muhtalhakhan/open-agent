/**
 * Specification format for user-built tools.
 *
 * Each tool spec defines either a shell sandbox command (arguments passed as
 * environment variables, never string-spliced) or an HTTP request constrained
 * by a network policy.
 */

/** A network policy that constrains which hosts the HTTP tool may reach. */
export interface NetworkPolicySpec {
  /** Hosts explicitly allowed (e.g. ["api.example.com"]). */
  allowedHosts?: readonly string[]
  /** Hosts explicitly denied (checked before allowlist). */
  deniedHosts?: readonly string[]
  /** Whether loopback / private / link-local destinations are permitted. */
  allowLocal?: boolean
}

/** Shell sandbox command specification. */
export interface ShellToolSpec {
  kind: 'shell'
  /** The command to run (e.g. "git log"). Arguments come via env vars. */
  command: string
  /** Environment variable names that become the arguments. */
  envArgs: string[]
  /** Optional allowed command list (defaults to unrestricted). */
  allowedCommands?: readonly string[]
  /** Whether destructive commands (rm -rf, etc.) are allowed. Default false. */
  allowDestructive?: boolean
  /** Working directory relative to workspace root. */
  cwd?: string
  /** Timeout in milliseconds. */
  timeoutMs?: number
  /** Whether commands may reach the network (sandbox enforced). */
  network?: boolean
  /** Sandbox to use (e.g. "bubblewrap", "docker", "none"). */
  sandbox?: string
  /** Experimental: allow-list of env keys that can pass through to the command. */
  allowEnvDefault?: () => readonly string[]
}

/** HTTP request specification with a network policy constraint. */
export interface HttpToolSpec {
  kind: 'http'
  /** Default URL or endpoint template. */
  url?: string
  /** Allowed HTTP methods. */
  methods?: readonly string[]
  /** Network policy constraint (allowed/denied hosts, local access). */
  network: NetworkPolicySpec
  /** Optional secrets (credential placeholders like {{API_KEY}}). */
  secrets?: Record<string, string>
  /** Maximum response bytes. */
  maxResponseBytes?: number
  /** Timeout in milliseconds. */
  timeoutMs?: number
  /** Max redirect hops. */
  maxRedirects?: number
}

/** Union of the two supported spec kinds. */
export type ToolSpec = ShellToolSpec | HttpToolSpec

/** A saved tool file at `~/.openagent/tools/<name>.json`. */
export interface SavedToolFile {
  /** Version of the spec format (for future migration). */
  specVersion: number
  /** The tool spec (shell or http). */
  spec: ToolSpec
  /** When the file was approved and saved. */
  approvedAt: string
  /** Optional user description of why the tool exists. */
  note?: string
}

/** JSON schema for the tool arguments. */
export type JsonSchema = Record<string, unknown>
