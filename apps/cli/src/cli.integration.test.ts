import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises'
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

      // The task just run is in the history, from the live session, and its
      // transcript replays it.
      const history = (await fetch(`http://127.0.0.1:${port}/api/history`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((res) => res.json())) as { tasks: { taskId: string; sessionId?: string }[] }
      expect(history.tasks[0]).toMatchObject({ prompt: 'what indentation?', status: 'completed' })
      expect(history.tasks[0].sessionId).toBeUndefined()
      const transcript = (await fetch(`http://127.0.0.1:${port}/api/history/${history.tasks[0].taskId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((res) => res.json())) as { events: { type: string }[] }
      expect(transcript.events.at(-1)).toMatchObject({ type: 'task/end', status: 'completed', answer: 'ack' })

      // The answer was remembered, and the memory view lists it.
      const memory = (await fetch(`http://127.0.0.1:${port}/api/memory`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((res) => res.json())) as { provider: string; items: { content: string }[] }
      expect(memory.provider).toBe('in-memory')
      expect(memory.items.map((item) => item.content)).toEqual(['ack'])
      expect(provider.requests[0].messages.find((m) => m.role === 'user')?.content).toBe('what indentation?')

      child.kill('SIGINT')
      expect(await exited).toBe(0)
      expect(stdout).toMatch(/Session ID: session_[0-9a-f]+/)
    })

    it('saves settings to the .env it was started with, refusing what the page may not change', async () => {
      const envFile = path.join(repo, 'agent.env')
      await writeFile(
        envFile,
        `# kept\nOPENAI_BASE_URL=${provider.url}\nOPENAI_MODEL=test-model\nOPENAI_API_KEY=test-key\n`,
        { mode: 0o600 },
      )
      const port = await freePort()
      // Only the file configures it: none of the provider variables are in the environment.
      const { OPENAI_BASE_URL: _url, OPENAI_API_KEY: _key, OPENAI_MODEL: _model, ...inherited } = process.env
      const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, 'web', '--port', String(port)], {
        cwd: repo,
        env: { ...inherited, OPEN_AGENT_ENV_FILE: envFile, TMPDIR: repo },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      try {
        let stdout = ''
        const url = await new Promise<string>((resolve, reject) => {
          child.stdout.on('data', (chunk) => {
            stdout += chunk
            const match = stdout.match(/OpenAgent web UI: (\S+)/)
            if (match) resolve(match[1])
          })
          child.on('close', () => reject(new Error(`exited before serving:\n${stdout}`)))
        })
        const token = new URL(url).searchParams.get('token')!
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        const save = (changes: Record<string, string | null>) =>
          fetch(`http://127.0.0.1:${port}/api/settings`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ changes }),
          })

        const view = await fetch(`http://127.0.0.1:${port}/api/settings`, { headers }).then((res) => res.text())
        expect(view).not.toContain('test-key')

        expect((await save({ SHELL_SANDBOX: 'none' })).status).toBe(400)
        expect((await save({ BROWSER_USE: '1', TAVILY_API_KEY: 'tvly-new' })).status).toBe(200)

        expect(await readFile(envFile, 'utf8')).toBe(
          `# kept\nOPENAI_BASE_URL=${provider.url}\nOPENAI_MODEL=test-model\nOPENAI_API_KEY=test-key\nBROWSER_USE=1\nTAVILY_API_KEY=tvly-new\n`,
        )
        expect((await stat(envFile)).mode & 0o777).toBe(0o600)
      } finally {
        child.kill('SIGINT')
        await new Promise((done) => child.on('close', done))
      }
    })

    it('manages profiles in the home folder and saves the one to start with to .env', async () => {
      const envFile = path.join(repo, 'profiles.env')
      await writeFile(envFile, `OPENAI_BASE_URL=${provider.url}\nOPENAI_MODEL=test-model\nOPENAI_API_KEY=test-key\n`, {
        mode: 0o600,
      })
      const home = path.join(repo, 'home')
      const port = await freePort()
      const { OPENAI_BASE_URL: _url, OPENAI_API_KEY: _key, OPENAI_MODEL: _model, ...inherited } = process.env
      const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, 'web', '--port', String(port)], {
        cwd: repo,
        // HOME moves ~/.openagent/profiles, so the real one is never touched.
        env: { ...inherited, HOME: home, OPEN_AGENT_ENV_FILE: envFile, TMPDIR: repo },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      try {
        let stdout = ''
        const url = await new Promise<string>((resolve, reject) => {
          child.stdout.on('data', (chunk) => {
            stdout += chunk
            const match = stdout.match(/OpenAgent web UI: (\S+)/)
            if (match) resolve(match[1])
          })
          child.on('close', () => reject(new Error(`exited before serving:\n${stdout}`)))
        })
        const token = new URL(url).searchParams.get('token')!
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        const act = (action: Record<string, unknown>) =>
          fetch(`http://127.0.0.1:${port}/api/profiles`, { method: 'POST', headers, body: JSON.stringify(action) })
        const profile = (tools: Record<string, boolean>) => ({ name: 'Mine', model: 'other-model', tools })

        const view = (await fetch(`http://127.0.0.1:${port}/api/profiles`, { headers }).then((res) => res.json())) as {
          profiles: Array<{ id: string }>
        }
        expect(view.profiles.map((p) => p.id)).toContain('coding-agent')

        expect(
          (await act({ action: 'save', id: 'mine', create: true, profile: profile({ shell: true }) })).status,
        ).toBe(400)
        expect((await act({ action: 'save', id: 'mine', create: true, profile: profile({ http: true }) })).status).toBe(
          200,
        )
        expect((await act({ action: 'default', id: 'coding-agent' })).status).toBe(400)
        expect((await act({ action: 'default', id: 'mine' })).status).toBe(200)

        expect(await readFile(path.join(home, '.openagent', 'profiles', 'mine.yaml'), 'utf8')).toContain(
          'model: other-model',
        )
        expect(await readFile(envFile, 'utf8')).toMatch(/\nOPEN_AGENT_PROFILE=mine\n$/)
      } finally {
        child.kill('SIGINT')
        await new Promise((done) => child.on('close', done))
      }
    })

    it('with --plan, shows the diff in the browser and writes the file only once it is approved', async () => {
      // A model that writes a file, then answers once the write has a result.
      const model = createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => (raw += chunk))
        req.on('end', () => {
          const body = JSON.parse(raw)
          const result = body.messages.find((m: { role: string }) => m.role === 'tool')
          const message = result
            ? { role: 'assistant', content: `result: ${result.content}` }
            : {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'w1',
                    type: 'function',
                    function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes.md', content: 'hi\n' }) },
                  },
                ],
              }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message }] }))
        })
      })
      const modelPort = await new Promise<number>((resolve) =>
        model.listen(0, '127.0.0.1', () => resolve((model.address() as AddressInfo).port)),
      )
      const port = await freePort()
      const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, 'web', '--plan', '--port', String(port)], {
        cwd: repo,
        env: {
          ...process.env,
          OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}`,
          OPENAI_API_KEY: 'test-key',
          OPENAI_MODEL: 'test-model',
          FILES_TOOL: '1',
          FILES_ROOT: repo,
          TMPDIR: repo,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      try {
        let stdout = ''
        const url = await new Promise<string>((resolve, reject) => {
          child.stdout.on('data', (chunk) => {
            stdout += chunk
            const match = stdout.match(/OpenAgent web UI: (\S+)/)
            if (match) resolve(match[1])
          })
          child.on('close', () => reject(new Error(`exited before serving:\n${stdout}`)))
        })
        const token = new URL(url).searchParams.get('token')!
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
        const stream = await fetch(`http://127.0.0.1:${port}/api/events?token=${token}`)
        const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        const next = async (type: string) => {
          for (;;) {
            let end: number
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, end)
              buffer = buffer.slice(end + 2)
              if (!frame.startsWith('data: ')) continue
              const event = JSON.parse(frame.slice(6))
              if (event.type === type) return event
            }
            const { value, done } = await reader.read()
            if (done) throw new Error(`stream ended before ${type}`)
            buffer += value
          }
        }

        await fetch(`http://127.0.0.1:${port}/api/tasks`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ input: 'write notes.md' }),
        })
        const request = await next('approval/request')

        expect(request).toMatchObject({ tool: 'write_file', scopes: ['once', 'task'] })
        expect(request.planPreview).toContain('+hi')
        expect(existsSync(path.join(repo, 'notes.md'))).toBe(false)

        const widened = await fetch(`http://127.0.0.1:${port}/api/approvals/${request.approvalId}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ approved: true, scope: 'session' }),
        })
        expect(widened.status).toBe(400)
        await fetch(`http://127.0.0.1:${port}/api/approvals/${request.approvalId}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ approved: true, scope: 'once' }),
        })
        const end = await next('task/end')
        await reader.cancel()

        expect(end.status).toBe('completed')
        expect(await readFile(path.join(repo, 'notes.md'), 'utf8')).toBe('hi\n')
      } finally {
        child.kill('SIGINT')
        await new Promise((done) => child.on('close', done))
        await new Promise((done) => model.close(done))
      }
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

    it('runs the hooks file: a pre_tool_call hook blocks a write, and session hooks run at both ends', async () => {
      // The model asks for a write, then answers with whatever the call returned.
      const model = createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => (raw += chunk))
        req.on('end', () => {
          const result = JSON.parse(raw).messages.find((m: { role: string }) => m.role === 'tool')
          const message = result
            ? { role: 'assistant', content: `result: ${result.content}` }
            : {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'w1',
                    type: 'function',
                    function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.txt', content: 'x' }) },
                  },
                ],
              }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message }] }))
        })
      })
      const port = await new Promise<number>((resolve) =>
        model.listen(0, '127.0.0.1', () => resolve((model.address() as AddressInfo).port)),
      )
      // Outside the repo: a hooks file the agent's workspace contains is refused.
      const config = await mkdtemp(path.join(tmpdir(), 'open-agent-hooks-'))
      const hooksFile = path.join(config, 'hooks.json')
      await writeFile(
        hooksFile,
        JSON.stringify({
          hooks: [
            { event: 'pre_tool_call', tools: ['write_file'], command: 'echo "writes are frozen" >&2; exit 2' },
            { event: 'session_start', command: `cat > "${path.join(config, 'start.json')}"` },
            { event: 'session_stop', command: `touch "${path.join(config, 'stopped')}"` },
          ],
        }),
      )
      try {
        const { stdout, stderr, code } = await runCli(
          '',
          {
            OPENAI_BASE_URL: `http://127.0.0.1:${port}`,
            OPENAI_API_KEY: 'test-key',
            OPENAI_MODEL: 'test-model',
            FILES_TOOL: '1',
            OPEN_AGENT_HOOKS_FILE: hooksFile,
          },
          repo,
          ['-p', 'write out.txt', '--yes'],
        )

        expect(code).toBe(0)
        expect(stderr).toContain(`Hooks: 3 loaded from ${hooksFile}`)
        expect(stdout).toBe('result: Error: tool "write_file" was blocked: writes are frozen\n')
        expect(existsSync(path.join(repo, 'out.txt'))).toBe(false)
        expect(JSON.parse(await readFile(path.join(config, 'start.json'), 'utf8'))).toMatchObject({
          event: 'session_start',
          mode: 'print',
        })
        expect(existsSync(path.join(config, 'stopped'))).toBe(true)
      } finally {
        await new Promise((done) => model.close(done))
        await rm(config, { recursive: true, force: true })
      }
    })

    it('refuses to start with a hooks file inside the workspace', async () => {
      const hooksFile = path.join(repo, 'hooks.json')
      await writeFile(hooksFile, JSON.stringify({ hooks: [] }))

      const { stderr, code } = await runCli('', { ...env(), FILES_TOOL: '1', OPEN_AGENT_HOOKS_FILE: hooksFile }, repo, [
        '-p',
        'anything',
      ])

      expect(code).toBe(1)
      expect(stderr).toContain("inside the agent's workspace")
      expect(provider.requests).toHaveLength(0)
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
