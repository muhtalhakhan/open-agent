/**
 * The agent-facing authoring tool (issue #285, "create new tools on request").
 *
 * The user asks the agent for a capability it does not have. The agent calls
 * this tool with a spec — a shell command with arguments passed as env vars, or
 * an HTTP request behind a network policy. The spec is validated, shown to the
 * user for approval, saved to `~/.openagent/tools/`, and registered into the
 * live registry. Built tools are never `safe`; they are always `dangerous`, so
 * every later call still goes through the normal approval system.
 */
import type { ToolDefinition, ToolResult, ToolExecutionContext, ToolRegistry } from '@open-agent/agent'
import { checkUrl } from '@open-agent/agent'
import type { ToolSpec, ShellToolSpec, HttpToolSpec } from './spec-types.js'
import { checkEnvArgName } from './builder.js'
import { approveAndSaveTool } from './approval-flow.js'
import type { ToolApprovalPrompt } from './approval-prompt.js'
import { registerUserTool } from './loader.js'

export const CREATE_TOOL_NAME = 'create_tool'

const SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        'A short kebab-case name for the new tool (e.g. "git-log", "weather-lookup"). It becomes the filename under ' +
        '~/.openagent/tools/ and must not collide with a built-in tool name.',
    },
    description: { type: 'string', description: 'A one-line description of what the tool does.' },
    kind: { type: 'string', enum: ['shell', 'http'], description: 'What kind of tool to build.' },
    // Shell fields
    command: {
      type: 'string',
      description: 'Shell command to run. Arguments are passed as env vars, never spliced in.',
    },
    envArgs: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Names of environment variables that become the tool's arguments. Must not be runtime directives (PATH, LD_PRELOAD, ...).",
    },
    allowedCommands: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional allow-list of commands the shell spec may run.',
    },
    allowDestructive: {
      type: 'boolean',
      description: 'Whether destructive shell commands are allowed. Default false.',
    },
    // HTTP fields
    url: { type: 'string', description: 'Default URL for an HTTP tool. Arguments may override it.' },
    methods: { type: 'array', items: { type: 'string' }, description: 'Allowed HTTP methods.' },
    allowedHosts: { type: 'array', items: { type: 'string' }, description: 'Hosts the HTTP tool may reach.' },
    deniedHosts: { type: 'array', items: { type: 'string' }, description: 'Hosts the HTTP tool may not reach.' },
    allowLocal: { type: 'boolean', description: 'Whether the HTTP tool may reach loopback / private hosts.' },
  },
  required: ['name', 'description', 'kind'],
}

export interface CreateToolOptions {
  registry: ToolRegistry
  prompt: ToolApprovalPrompt
  /** Where approved tools are saved; defaults to the loader's user folder. */
  saveDir?: string
}

/** Validates a proposed spec as far as it can without running it. */
export function validateSpec(spec: ToolSpec): string | null {
  if (spec.kind === 'shell') {
    if (typeof spec.command !== 'string' || !spec.command.trim()) return 'shell spec needs a command'
    if (!Array.isArray(spec.envArgs)) return 'shell spec needs envArgs (possibly empty)'
    for (const name of spec.envArgs) {
      try {
        checkEnvArgName(name)
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    }
    return null
  }
  if (spec.kind === 'http') {
    if (!spec.network || typeof spec.network !== 'object') return 'http spec needs a network policy'
    // If a default URL is given, it must be allowed by the policy up front.
    if (spec.url) {
      try {
        checkUrl(spec.url, {
          allowedHosts: spec.network.allowedHosts,
          deniedHosts: spec.network.deniedHosts,
          allowLocal: spec.network.allowLocal,
        })
      } catch (e) {
        return e instanceof Error ? e.message : 'invalid URL'
      }
    }
    return null
  }
  return `unknown spec kind: ${(spec as { kind?: string }).kind ?? '(missing)'}`
}

/** Turn the model's arguments into a typed spec, or explain why they do not fit. */
export function parseCreateArgs(
  args: Record<string, unknown>,
): { ok: true; spec: ToolSpec } | { ok: false; error: string } {
  const kind = args.kind
  if (kind !== 'shell' && kind !== 'http')
    return { ok: false, error: `kind must be "shell" or "http", got ${String(kind)}` }

  if (kind === 'shell') {
    const envArgs = Array.isArray(args.envArgs) ? args.envArgs.map(String) : []
    const spec: ShellToolSpec = {
      kind: 'shell',
      command: String(args.command ?? ''),
      envArgs,
      ...(Array.isArray(args.allowedCommands) ? { allowedCommands: args.allowedCommands.map(String) } : {}),
      ...(typeof args.allowDestructive === 'boolean' ? { allowDestructive: args.allowDestructive } : {}),
    }
    return { ok: true, spec }
  }

  const network: HttpToolSpec['network'] = {
    ...(Array.isArray(args.allowedHosts) ? { allowedHosts: args.allowedHosts.map(String) } : {}),
    ...(Array.isArray(args.deniedHosts) ? { deniedHosts: args.deniedHosts.map(String) } : {}),
    ...(typeof args.allowLocal === 'boolean' ? { allowLocal: args.allowLocal } : {}),
  }
  const spec: HttpToolSpec = {
    kind: 'http',
    network,
    ...(typeof args.url === 'string' ? { url: args.url } : {}),
    ...(Array.isArray(args.methods) ? { methods: args.methods.map(String) } : {}),
  }
  return { ok: true, spec }
}

/**
 * The `create_tool` tool the agent calls to author a new capability.
 *
 * The spec is validated, shown to the user, and only saved and registered on
 * explicit approval. The built tool joins the registry under the chosen name
 * (failing rather than shadowing a built-in), and is `dangerous` like any other
 * user-built tool.
 */
export function createToolTool(options: CreateToolOptions): ToolDefinition<Record<string, unknown>> {
  const { registry, prompt } = options
  return {
    name: CREATE_TOOL_NAME,
    description:
      'Propose a new tool for this agent, of your own design, that the user must approve before it is saved. ' +
      'Use this when the user asks for a capability no existing tool provides. A shell tool runs one command with ' +
      'its arguments passed as environment variables (never interpolated into the command); an HTTP tool makes a ' +
      'request constrained by a network policy. The spec is shown to the user and saved only if they approve. ' +
      "Built tools are always dangerous and load only from the user's personal folder.",
    schema: SCHEMA,
    permissionLevel: 'dangerous',
    async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
      const name = String(args.name ?? '').trim()
      const description = String(args.description ?? '').trim()
      if (!name) return fail('a tool name is required')
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
        return fail(`tool name "${name}" must be lowercase letters, digits, underscores and dashes`)
      }
      if (!description) return fail('a description is required')

      const parsed = parseCreateArgs(args)
      if (!parsed.ok) return fail(parsed.error)
      const problem = validateSpec(parsed.spec)
      if (problem) return fail(problem)

      const approved = await approveAndSaveTool(prompt, name, description, parsed.spec, undefined, options.saveDir)
      if (!approved.saved || !approved.path) {
        return { ok: false, content: '', error: 'The user did not approve this tool. It was not saved.' }
      }

      try {
        const loaded = { name, spec: parsed.spec }
        registerUserTool(registry, loaded)
      } catch (e) {
        return fail(
          `Saved the spec to ${approved.path}, but could not register it: ${
            e instanceof Error ? e.message : String(e)
          }. It will load on the next run once the name is free.`,
        )
      }

      return {
        ok: true,
        content:
          `Saved and registered tool "${name}" (${parsed.spec.kind}) at ${approved.path}. ` +
          `It is now available this session as a dangerous tool; call it by the name "${name}".`,
      }
    },
  }
}

function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}
