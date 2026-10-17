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

  // Regression: readline emits a `line` event per line of a chunk, whether or
  // not a question is waiting. Only the first found one, and the rest were
  // emitted to nobody.
  it('runs every line when several arrive in one stdin chunk', async () => {
    await runCli('first\nsecond\n:exit\n', env(), repo)

    expect(provider.requests).toHaveLength(2)
    expect(provider.requests.map((r) => r.messages.find((m) => m.role === 'user')?.content)).toEqual([
      'first',
      'second',
    ])
  })

  // The same drop, but for the very first line: with a file or shell tool
  // enabled the CLI awaits real I/O before its first prompt, so `echo task |
  // open-agent` lost the task itself.
  it('runs a piped task when startup awaits I/O before the first prompt', async () => {
    const { stdout } = await runCli('hello there\n:exit\n', { ...env(), FILES_TOOL: '1' }, repo)

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

  // Regression: Ctrl+C at an idle prompt called process.exit(0), which killed
  // background jobs and skipped saving the session.
  it('saves the session when interrupted at an idle prompt', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliEntry], {
      cwd: repo,
      env: { ...process.env, ...env(), CLI_NO_TUI: '1', TMPDIR: repo },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.includes('> ') && !child.killed) child.kill('SIGINT')
    })
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))

    expect(code).toBe(0)
    expect(stdout).toMatch(/Session ID: session_[0-9a-f]+/)
  })

  it('lets the model check a claim with Jev when a TypeSafe key is configured', async () => {
    const jevRequests: { auth?: string; body: { questions: Record<string, { type: string }> } }[] = []
    const jev = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        jevRequests.push({ auth: req.headers.authorization, body: JSON.parse(raw) })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ model: 'jev-test', answers: { q0: { type: 'noul', noul: 0.93 } } }))
      })
    })
    // A model that checks a claim first, then answers with what came back.
    const modelRequests: { messages: { role: string; content: string | null }[] }[] = []
    const model = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const body = JSON.parse(raw)
        modelRequests.push(body)
        const result = body.messages.find((m: { role: string }) => m.role === 'tool')
        const message = result
          ? { role: 'assistant', content: `checked: ${result.content}` }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: {
                    name: 'check_claims',
                    arguments: JSON.stringify({ evidence: '12 passed, 0 failed', checks: { pass: 'Did all pass?' } }),
                  },
                },
              ],
            }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message }] }))
      })
    })
    const listen = (server: Server) =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
      )
    const [jevPort, modelPort] = await Promise.all([listen(jev), listen(model)])

    try {
      const { stdout, stderr, code } = await runCli(
        '',
        {
          OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}`,
          OPENAI_API_KEY: 'test-key',
          OPENAI_MODEL: 'test-model',
          TYPESAFE_API_KEY: 'ts_test',
          TYPESAFE_BASE_URL: `http://127.0.0.1:${jevPort}`,
        },
        repo,
        ['-p', 'did the tests pass?'],
      )

      expect(code).toBe(0)
      expect(stderr).toContain('Decision tools loaded')
      expect(jevRequests).toHaveLength(1)
      expect(jevRequests[0].auth).toBe('Bearer ts_test')
      expect(jevRequests[0].body.questions.q0.type).toBe('noul')
      expect(stdout).toBe('checked: [{"id":"pass","probability":0.93,"verdict":"yes"}]\n')
    } finally {
      await new Promise((done) => jev.close(done))
      await new Promise((done) => model.close(done))
    }
  })

  it('with DECISION_LAYER, offers only the tools Jev keeps and answers with the light model', async () => {
    const jev = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const { state, questions } = JSON.parse(raw)
        const answers: Record<string, unknown> = {}
        for (const [key, text] of Object.entries(state.tools ?? {}) as [string, string][]) {
          answers[key] = { type: 'noul', noul: text.startsWith('read_file') ? 0.95 : 0.02 }
        }
        if (questions.route) {
          answers.route = {
            type: 'choice',
            choice: 'light',
            probabilities: { light: 0.93, heavy: 0.07 },
            confidence: 0.9,
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 500, output_tokens: 9 } }))
      })
    })
    const modelRequests: { model: string; tools?: { function: { name: string } }[] }[] = []
    const model = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        modelRequests.push(JSON.parse(raw))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }] }))
      })
    })
    const listen = (server: Server) =>
      new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
      )
    const [jevPort, modelPort] = await Promise.all([listen(jev), listen(model)])

    try {
      const { stdout, stderr, code } = await runCli(
        '',
        {
          OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}`,
          OPENAI_API_KEY: 'test-key',
          OPENAI_MODEL: 'big-model',
          OPENAI_MODEL_LIGHT: 'small-model',
          FILES_TOOL: '1',
          TYPESAFE_API_KEY: 'ts_test',
          TYPESAFE_BASE_URL: `http://127.0.0.1:${jevPort}`,
          DECISION_LAYER: 'tools,route',
        },
        repo,
        ['-p', 'what does the README say?'],
      )

      expect(code).toBe(0)
      expect(stdout).toBe('done\n')
      expect(stderr).toContain('Decision layer on')
      expect(modelRequests).toHaveLength(1)
      expect(modelRequests[0].model).toBe('small-model')
      expect(modelRequests[0].tools?.map((tool) => tool.function.name)).toEqual(['read_file'])
    } finally {
      await new Promise((done) => jev.close(done))
      await new Promise((done) => model.close(done))
    }
  })

  describe('web', () => {
    /** A port nothing is listening on, found by asking the OS for one and giving it back. */
    function freePort(): Promise<number> {
      return new Promise((resolve) => {
        const probe = createServer()
        probe.listen(0, '127.0.0.1', () => {
          const { port } = probe.address() as AddressInfo
          probe.close(() => resolve(port))
        })
      })
    }

    /** Reads server-sent events until one carries `type`, returning them all. */
    async function readUntil(body: ReadableStream<Uint8Array>, type: string): Promise<{ type: string }[]> {
      const events: { type: string }[] = []
      const reader = body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return events
        buffer += value
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (!frame.startsWith('data: ')) continue
          events.push(JSON.parse(frame.slice(6)))
          if (events.at(-1)?.type === type) {
            await reader.cancel()
            return events
          }
        }
      }
    }

    it('runs a task sent from the browser and saves the session on Ctrl+C', async () => {
      const port = await freePort()
      const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, 'web', '--port', String(port)], {
        cwd: repo,
        env: { ...process.env, ...env(), TMPDIR: repo },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      const url = await new Promise<string>((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          stdout += chunk
          const match = stdout.match(/OpenAgent web UI: (\S+)/)
          if (match) resolve(match[1])
        })
        child.on('close', () => reject(new Error(`exited before serving:\n${stdout}`)))
      })
      const exited = new Promise<number | null>((resolve) => child.on('close', resolve))
      const token = new URL(url).searchParams.get('token')!
      expect(new URL(url).host).toBe(`127.0.0.1:${port}`)

      const stream = await fetch(`http://127.0.0.1:${port}/api/events?token=${token}`)
      const sent = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'what indentation?' }),
      })
      expect(sent.status).toBe(202)
      const events = await readUntil(stream.body!, 'task/end')

      expect(events.at(-1)).toMatchObject({ type: 'task/end', status: 'completed', answer: 'ack' })
      expect(provider.requests[0].messages.find((m) => m.role === 'user')?.content).toBe('what indentation?')

      child.kill('SIGINT')
      expect(await exited).toBe(0)
      expect(stdout).toMatch(/Session ID: session_[0-9a-f]+/)
    })

    it('refuses --plan, which needs a review the web UI cannot show yet', async () => {
      const { stderr, code } = await runCli('', env(), repo, ['web', '--plan'])

      expect(code).toBe(1)
      expect(stderr).toContain('#109')
      expect(provider.requests).toHaveLength(0)
    })
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

    it('lists past tasks with --history, without needing a provider configured', async () => {
      // Sessions are saved under the OS temp dir; point it somewhere private.
      const tmp = path.join(repo, 'tmp')
      await mkdir(tmp)
      await runCli('', { ...env(), TMPDIR: tmp }, repo, ['-p', 'what indentation?'])

      const { stdout, code } = await runCli('', { TMPDIR: tmp, OPENAI_API_KEY: '', OPENAI_BASE_URL: '' }, repo, [
        '--history',
      ])

      expect(code).toBe(0)
      expect(stdout).toMatch(/completed +what indentation\?\n {4}ack\n {4}session_[0-9a-f]+ · 0 tool calls/)
      expect(provider.requests).toHaveLength(1)
    })

    it('prints usage for --help without contacting a provider', async () => {
      const { stdout, code } = await runCli('', env(), repo, ['--help'])

      expect(code).toBe(0)
      expect(stdout).toContain('Usage')
      expect(provider.requests).toHaveLength(0)
    })
  })
})
