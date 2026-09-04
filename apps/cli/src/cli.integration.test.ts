import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const srcDir = path.dirname(fileURLToPath(import.meta.url))
const cliEntry = path.join(srcDir, 'index.ts')
// apps/cli/src -> apps/cli -> apps -> repo root
const projectRoot = path.resolve(srcDir, '../../..')

interface CapturedRequest {
  messages: { role: string; content: string }[]
}

/** A stand-in for an OpenAI-compatible endpoint that records what it was sent. */
function startFakeProvider(): Promise<{ url: string; requests: CapturedRequest[]; close: () => Promise<void> }> {
  const requests: CapturedRequest[] = []
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      requests.push(JSON.parse(raw))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ack' } }] }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/** Runs the real CLI entrypoint with piped stdin, as a script or CI job would. */
function runCli(
  input: string,
  env: Record<string, string>,
  cwd: string,
  argv: string[] = [],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, ...argv], {
      cwd,
      env: { ...process.env, ...env, CLI_NO_TUI: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    // Kept apart: print mode's contract is that stdout carries the answer and
    // nothing else, which a merged stream could not detect.
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }))
    child.stdin.end(input)
  })
}

let provider: Awaited<ReturnType<typeof startFakeProvider>>
let repo: string

beforeEach(async () => {
  provider = await startFakeProvider()
  repo = await mkdtemp(path.join(tmpdir(), 'open-agent-cli-'))
  await mkdir(path.join(repo, '.git'))
  // The child runs with the temp repo as its cwd — that's what makes root
  // discovery real — so it needs the project's modules resolvable from there.
  await symlink(path.join(projectRoot, 'node_modules'), path.join(repo, 'node_modules'), 'dir')
})

afterEach(async () => {
  await provider.close()
  await rm(repo, { recursive: true, force: true })
})

describe('CLI end to end', () => {
  const env = () => ({
    OPENAI_BASE_URL: provider.url,
    OPENAI_API_KEY: 'test-key',
    OPENAI_MODEL: 'test-model',
  })

  // Regression: an `await` between createInterface() and the first prompt
  // lets readline consume and discard piped input, so the CLI would print
  // its banner and exit without ever running the task.
  it('runs a task from piped stdin', async () => {
    const { stdout } = await runCli('what indentation?\n:exit\n', env(), repo)

    expect(provider.requests).toHaveLength(1)
    expect(stdout).toContain('ack')
  })

  it('loads AGENTS.md from the repo root into the system message', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), '# Conventions\n\n- Always indent with tabs.')

    const { stdout } = await runCli('what indentation?\n:exit\n', env(), repo)

    const system = provider.requests[0].messages.find((m) => m.role === 'system')
    expect(system?.content).toContain('Always indent with tabs.')
    // Named relative to the repo root, not the cwd.
    expect(stdout).toContain('Loaded project conventions from AGENTS.md')
  })

  it('leaves the user message exactly as typed', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), '- Always indent with tabs.')

    await runCli('what indentation?\n:exit\n', env(), repo)

    const user = provider.requests[0].messages.find((m) => m.role === 'user')
    expect(user?.content).toBe('what indentation?')
  })

  it('sends no system message when the repo has no conventions file', async () => {
    const { stdout } = await runCli('hello\n:exit\n', env(), repo)

    expect(provider.requests[0].messages.some((m) => m.role === 'system')).toBe(false)
    expect(stdout).not.toContain('Loaded project conventions')
  })

  describe('print mode', () => {
    it('prints only the answer on stdout and exits 0', async () => {
      const { stdout, stderr, code } = await runCli('', env(), repo, ['-p', 'what indentation?'])

      expect(code).toBe(0)
      expect(stdout).toBe('ack\n')
      expect(stderr).toBe('')
      expect(provider.requests).toHaveLength(1)
    })

    it('reads the task from stdin when -p is given no value', async () => {
      const { stdout, code } = await runCli('task from stdin\n', env(), repo, ['-p'])

      expect(code).toBe(0)
      expect(stdout).toBe('ack\n')
      const user = provider.requests[0].messages.find((m) => m.role === 'user')
      expect(user?.content).toBe('task from stdin')
    })

    it('keeps diagnostics off stdout so the answer can be captured cleanly', async () => {
      await writeFile(path.join(repo, 'AGENTS.md'), '- Always indent with tabs.')

      const { stdout, stderr } = await runCli('', env(), repo, ['-p', 'what indentation?'])

      expect(stdout).toBe('ack\n')
      expect(stderr).toContain('Loaded project conventions from AGENTS.md')
    })

    it('exits 1 with an empty stdout when the provider is unreachable', async () => {
      const badEnv = { ...env(), OPENAI_BASE_URL: 'http://127.0.0.1:1' }

      const { stdout, stderr, code } = await runCli('', badEnv, repo, ['-p', 'anything'])

      expect(code).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('Task failed')
    })

    it('exits 1 and suggests -p when a task is passed without the flag', async () => {
      const { stderr, code } = await runCli('', env(), repo, ['summarize the tests'])

      expect(code).toBe(1)
      expect(stderr).toContain('-p "summarize the tests"')
      expect(provider.requests).toHaveLength(0)
    })

    it('prints usage for --help without contacting a provider', async () => {
      const { stdout, code } = await runCli('', env(), repo, ['--help'])

      expect(code).toBe(0)
      expect(stdout).toContain('Usage')
      expect(provider.requests).toHaveLength(0)
    })
  })
})
