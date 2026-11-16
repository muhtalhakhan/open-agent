import type { ToolDefinition, ToolResult, NetworkPolicy, ToolExecutionContext } from '@open-agent/agent'
import { checkUrl, filterEnv } from '@open-agent/agent'
import { createGuardedFetch } from '@open-agent/tools-http'
import { execute, checkCommand } from '@open-agent/tools-terminal'
import type { ShellToolSpec, HttpToolSpec } from './spec-types.js'

/**
 * Environment variables the shell or a runtime interprets as instructions
 * rather than data: `NODE_OPTIONS` loads code into every node process,
 * `LD_PRELOAD` into every process, `PATH` and `BASH_ENV` redirect what runs.
 * An envArg named like one of these is an argument the model can turn into a
 * directive, so the spec that names one is refused at build time — the
 * approval prompt would otherwise show a name, not what it does.
 */
const FORBIDDEN_ENV_ARGS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'ENV',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'GEM_HOME',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'CLASSPATH',
  'DOTNET_CLI_HOME',
  'MSBuildSDKsPath',
  'PSModulePath',
  'PROMPT',
  'PS1',
  'LD_DEBUG',
  'TMPDIR',
  'TEMP',
  'TMP',
  'CDPATH',
  'IFS',
  'BASH_XTRACEFD',
  'BASH_COMPAT',
  'SHELLOPTS',
  'BASHOPTS',
])

/** Error result for a failed tool execution. */
function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

/** JSON schema describing the environment-variable arguments. */
export function shellSchema(envArgs: readonly string[]): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  for (const name of envArgs) {
    props[name] = { type: 'string', description: `Argument for ${name}.` }
  }
  return { type: 'object', properties: props, required: envArgs.slice() }
}

/**
 * Checks an envArg name against the denylist, throwing before the tool is
 * registered. The build-time check is what makes the approval prompt honest:
 * what the user approved is what runs, with no runtime reinterpretation.
 */
export function checkEnvArgName(name: string): void {
  if (FORBIDDEN_ENV_ARGS.has(name.toUpperCase())) {
    throw new Error(`envArg "${name}" is a runtime directive, not an argument; remove it from the spec`)
  }
}

/** Builds a shell sandbox tool definition from its spec. Always dangerous. */
export function buildShellTool(spec: ShellToolSpec): ToolDefinition<Record<string, unknown>> {
  const allowedCommands = spec.allowedCommands ?? undefined
  const allowDestructive = spec.allowDestructive ?? false
  const timeoutMs = Math.min(spec.timeoutMs ?? 120_000, 600_000)
  for (const name of spec.envArgs ?? []) checkEnvArgName(name)

  return {
    name: 'built_shell_tool',
    description:
      'A user-configured shell sandbox command. ' +
      `Command: "${spec.command}". ` +
      `Arguments: environment variables (${spec.envArgs.join(', ')}).`,
    schema: shellSchema(spec.envArgs),
    permissionLevel: 'dangerous',
    async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
      const command = spec.command
      try {
        checkCommand(command, { allowedCommands, allowDestructive })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return fail(msg)
      }

      // Arguments are NEVER string-spliced into the command. They are passed as env vars.
      // They are layered *under* the filtered parent environment's own values for
      // these names, so an arg cannot overwrite PATH or NODE_OPTIONS even if a
      // hand-edited spec slipped past the build-time check.
      const userEnv: Record<string, string> = {}
      for (const key of spec.envArgs ?? []) {
        if (FORBIDDEN_ENV_ARGS.has(key.toUpperCase())) continue
        const val = args[key]
        if (val !== undefined && val !== null) userEnv[key] = String(val)
      }

      const filterResult = filterEnv(process.env, spec.allowEnvDefault ? spec.allowEnvDefault() : [])
      const mergedEnv = { ...filterResult.env, ...userEnv }

      try {
        const result = await execute({
          command,
          cwd: spec.cwd ?? '.',
          workspaceRoot: process.cwd(),
          env: mergedEnv,
          timeoutMs,
          maxOutputBytes: 64_000,
          signal: context.signal,
          network: spec.network ?? false,
        })
        return { ok: true, content: renderShellResult(result, timeoutMs) }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return fail(msg)
      }
    },
  }
}

/** JSON schema for HTTP request arguments. */
export function httpSchema(defaultMethod: string, allowedMethods: readonly string[]): Record<string, unknown> {
  const methods = allowedMethods.length > 0 ? allowedMethods.slice() : ['GET', 'POST']
  return {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute URL.' },
      method: { type: 'string', enum: methods.slice(), description: `HTTP method (default ${defaultMethod}).` },
      headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional request headers.' },
      body: { type: 'string', description: 'Request body (serialized).' },
    },
    required: ['url'],
  }
}

/** Builds an HTTP request tool definition from its spec. Always dangerous. */
export function buildHttpTool(spec: HttpToolSpec): ToolDefinition<Record<string, unknown>> {
  const defaultMethod = spec.methods?.[0] ?? 'GET'
  const allowedMethods = spec.methods ?? ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  const networkPolicy = convertNetworkSpec(spec.network)

  return {
    name: 'built_http_tool',
    description:
      'A user-configured HTTP request with a network policy. ' +
      `Allowed hosts: ${spec.network.allowedHosts?.join(', ') || '(any)'}; ` +
      `Denied hosts: ${spec.network.deniedHosts?.join(', ') || '(none)'}; ` +
      `Local allowed: ${spec.network.allowLocal ?? false}.`,
    schema: httpSchema(defaultMethod, allowedMethods),
    permissionLevel: 'dangerous',
    async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
      const url = String(args.url ?? spec.url ?? '')
      const method = String(args.method ?? defaultMethod)

      if (!url) return fail('url is required')
      try {
        checkUrl(url, networkPolicy)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'invalid URL'
        return fail(msg)
      }

      try {
        const guarded = createGuardedFetch({ policy: networkPolicy, maxRedirects: spec.maxRedirects ?? 3 })
        const bodyStr = args.body ? String(args.body) : ''
        const headers: Record<string, string> = {}
        if (args.headers && typeof args.headers === 'object' && args.headers !== null) {
          for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
            headers[String(k)] = String(v)
          }
        }

        const fetchResponse = await guarded.fetch(url, { method, headers, body: bodyStr, signal: context.signal })
        const response = fetchResponse.response

        const maxBytes = spec.maxResponseBytes ?? 64_000
        const reader = response.body ? response.body.getReader() : null
        let text = ''
        if (reader) {
          let bytesRead = 0
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            bytesRead += value ? value.byteLength : 0
            text += new TextDecoder().decode(value, { stream: true })
            if (bytesRead > maxBytes) break
          }
        }
        text = text.slice(0, maxBytes)
        return { ok: true, content: `${response.status}\n${text}` }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return fail(msg)
      }
    },
  }
}

export function convertNetworkSpec(spec: {
  allowedHosts?: readonly string[]
  deniedHosts?: readonly string[]
  allowLocal?: boolean
}): NetworkPolicy {
  return {
    allowedHosts: spec.allowedHosts,
    deniedHosts: spec.deniedHosts,
    allowLocal: spec.allowLocal,
  }
}

function renderShellResult(result: Awaited<ReturnType<typeof execute>>, timeoutMs: number): string {
  const parts: string[] = []
  if (result.timedOut) parts.push(`[timed out after ${timeoutMs}ms and was killed]`)
  else if (result.cancelled) parts.push('[cancelled]')
  else if (result.signal) parts.push(`[killed by ${result.signal}]`)
  else parts.push(`exit code: ${result.code ?? ''}`)
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`)
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`)
  if (!result.stdout.trim() && !result.stderr.trim()) parts.push('(no output)')
  if (result.truncated) parts.push('[output was truncated at the byte ceiling]')
  return parts.join('\n\n')
}

/** Helper exposed for tests. */
export function allowEnvDefault(): readonly string[] {
  return []
}
