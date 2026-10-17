import { request, type IncomingHttpHeaders } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerEvent } from './protocol.js'
import type { SessionEvent } from '@open-agent/agent'
import {
  startWebServer,
  type ApprovalAnswer,
  type ApprovalRequest,
  type RunTask,
  type TaskHooks,
  type WebServer,
  type WebServerOptions,
} from './server.js'

const TOKEN = 'test-token'

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** Raw node:http rather than fetch, which will not let a test forge `Host` or `Origin`. */
function send(
  server: WebServer,
  method: string,
  pathname: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path: pathname,
        headers: { Host: `127.0.0.1:${server.port}`, ...headers },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

function postTask(server: WebServer, input: string, headers: Record<string, string> = {}) {
  return send(server, 'POST', '/api/tasks', { headers: { ...auth, ...headers }, body: JSON.stringify({ input }) })
}

/** Follows the event stream until `until` matches, then hands back everything received. */
function collect(server: WebServer, until: (event: ServerEvent) => boolean): Promise<ServerEvent[]> {
  return new Promise((resolve, reject) => {
    const events: ServerEvent[] = []
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: `/api/events?token=${TOKEN}`,
        headers: { Host: `127.0.0.1:${server.port}` },
      },
      (res) => {
        let buffer = ''
        res.on('data', (chunk) => {
          buffer += chunk
          let end: number
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            if (!frame.startsWith('data: ')) continue
            const event = JSON.parse(frame.slice(6)) as ServerEvent
            events.push(event)
            if (until(event)) {
              req.destroy()
              resolve(events)
              return
            }
          }
        })
      },
    )
    req.on('error', (err) => (events.length ? undefined : reject(err)))
    req.end()
  })
}

/** A stand-in for the agent: plays a fixed script through the hooks, the way executeTask would. */
function scriptedTask(play: (hooks: TaskHooks, signal: AbortSignal) => Promise<void> | void, answer = 'done'): RunTask {
  return async (_input, signal, hooks) => {
    await play(hooks, signal)
    if (signal.aborted) return { status: 'cancelled', answer: '' }
    return { status: 'completed', answer }
  }
}

const toolCall = (hooks: TaskHooks, ok: boolean) => {
  const call = { id: 'call-1', name: 'read_file', args: { path: 'a.txt' } }
  hooks.onEvent({ type: 'tool/call', taskId: 't', at: 1000, call })
  hooks.onEvent({
    type: 'tool/result',
    taskId: 't',
    at: 1042,
    callId: 'call-1',
    result: ok
      ? { ok: true, content: 'hello' }
      : { ok: false, content: '', error: 'requires approval and was not approved' },
  })
}

let server: WebServer | undefined
let clientDir: string

beforeEach(async () => {
  clientDir = await mkdtemp(path.join(tmpdir(), 'web-client-'))
})

afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(clientDir, { recursive: true, force: true })
})

async function start(
  runTask: RunTask = scriptedTask(() => {}),
  history?: WebServerOptions['history'],
): Promise<WebServer> {
  server = await startWebServer({ runTask, port: 0, token: TOKEN, clientDir, history })
  return server
}

describe('startWebServer', () => {
  it('listens on loopback and puts the token in the URL it reports', async () => {
    const s = await start()
    expect(s.url).toBe(`http://127.0.0.1:${s.port}/?token=${TOKEN}`)
  })

  it('refuses the API without the right token', async () => {
    const s = await start()

    expect((await send(s, 'GET', '/api/events')).status).toBe(401)
    expect((await send(s, 'GET', '/api/events?token=wrong')).status).toBe(401)
    expect((await postTask(s, 'hi', { Authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await postTask(s, 'hi', { Authorization: 'Bearer tes' })).status).toBe(401)
  })

  it('refuses a request that names another host, as a DNS-rebinding page would', async () => {
    const s = await start()

    const reply = await postTask(s, 'hi', { Host: `evil.example:${s.port}` })

    expect(reply.status).toBe(403)
  })

  it('refuses a POST from another origin, and one that is not JSON', async () => {
    const s = await start()

    expect((await postTask(s, 'hi', { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await postTask(s, 'hi', { Origin: 'null' })).status).toBe(403)
    const form = await send(s, 'POST', '/api/tasks', {
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ input: 'hi' }),
    })
    expect(form.status).toBe(415)
  })

  it('accepts a task from its own origin', async () => {
    const s = await start()

    const reply = await postTask(s, 'hi', { Origin: `http://localhost:${s.port}` })

    expect(reply.status).toBe(202)
    expect(JSON.parse(reply.body)).toHaveProperty('taskId')
  })

  it('rejects an empty task', async () => {
    const s = await start()

    expect((await postTask(s, '   ')).status).toBe(400)
  })

  it('streams a task: its start, the reply as it is written, its tool calls, and how it ended', async () => {
    const s = await start(
      scriptedTask((hooks) => {
        toolCall(hooks, true)
        hooks.onText({ type: 'delta', text: 'Hel' })
        hooks.onText({ type: 'delta', text: 'lo' })
        hooks.onText({ type: 'end' })
      }, 'Hello'),
    )
    const stream = collect(s, (event) => event.type === 'task/end')
    // The stream has to be open before the task starts, or this is a replay test.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const reply = await postTask(s, 'say hello')
    const { taskId } = JSON.parse(reply.body) as { taskId: string }
    const events = await stream

    expect(events).toEqual([
      { type: 'hello' },
      { type: 'task/start', taskId, input: 'say hello' },
      { type: 'tool/start', taskId, callId: 'call-1', name: 'read_file', args: '{"path":"a.txt"}' },
      { type: 'tool/end', taskId, callId: 'call-1', ok: true, ms: 42 },
      { type: 'text', taskId, event: { type: 'delta', text: 'Hel' } },
      { type: 'text', taskId, event: { type: 'delta', text: 'lo' } },
      { type: 'text', taskId, event: { type: 'end' } },
      { type: 'task/end', taskId, status: 'completed', answer: 'Hello' },
    ])
  })

  it('passes on what the task cost', async () => {
    const s = await start(async () => ({
      status: 'completed',
      answer: 'hi',
      usage: { inputTokens: 300, outputTokens: 4 },
    }))

    await postTask(s, 'go')
    const events = await collect(s, (event) => event.type === 'task/end')

    expect(events.at(-1)).toMatchObject({ type: 'task/end', usage: { inputTokens: 300, outputTokens: 4 } })
  })

  it('carries a denied call through with its reason', async () => {
    const s = await start(scriptedTask((hooks) => toolCall(hooks, false)))

    await postTask(s, 'read it')
    const events = await collect(s, (event) => event.type === 'task/end')

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool/end', ok: false, error: 'requires approval and was not approved' }),
    )
  })

  it('replays the conversation to a tab that connects later, each reply whole rather than delta by delta', async () => {
    const s = await start(
      scriptedTask((hooks) => {
        for (const text of ['a', 'b', 'c']) hooks.onText({ type: 'delta', text })
        hooks.onText({ type: 'end' })
      }, 'abc'),
    )
    s.notice('Shell sandbox: bubblewrap\n')
    await postTask(s, 'go')
    await collect(s, (event) => event.type === 'task/end')

    const events = await collect(s, (event) => event.type === 'task/end')

    expect(events.map((event) => event.type)).toEqual(['hello', 'notice', 'task/start', 'text', 'text', 'task/end'])
    expect(events[1]).toEqual({ type: 'notice', text: 'Shell sandbox: bubblewrap' })
    expect(events[3]).toMatchObject({ event: { type: 'delta', text: 'abc' } })
  })

  it('runs one task at a time, and cancels the running one on request', async () => {
    let started!: () => void
    const running = new Promise<void>((resolve) => (started = resolve))
    const s = await start(
      scriptedTask(
        (_hooks, signal) =>
          new Promise<void>((resolve) => {
            started()
            signal.addEventListener('abort', () => resolve())
          }),
      ),
    )

    const first = JSON.parse((await postTask(s, 'long job')).body) as { taskId: string }
    await running
    expect((await postTask(s, 'another')).status).toBe(409)

    expect((await send(s, 'POST', '/api/tasks/nope/cancel', { headers: auth, body: '{}' })).status).toBe(404)
    const cancel = await send(s, 'POST', `/api/tasks/${first.taskId}/cancel`, { headers: auth, body: '{}' })
    expect(cancel.status).toBe(202)

    const events = await collect(s, (event) => event.type === 'task/end')
    expect(events.at(-1)).toMatchObject({ type: 'task/end', status: 'cancelled' })
    expect((await postTask(s, 'another')).status).toBe(202)
  })

  it('reports a task that throws as failed rather than leaving it running', async () => {
    const s = await start(async () => {
      throw new Error('model unreachable')
    })

    await postTask(s, 'go')
    const events = await collect(s, (event) => event.type === 'task/end')

    expect(events.at(-1)).toMatchObject({ status: 'error', error: 'model unreachable' })
    expect((await postTask(s, 'again')).status).toBe(202)
  })

  it('cancels and waits for a running task when it closes', async () => {
    let finished = false
    const s = await start(
      scriptedTask(
        (_hooks, signal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener('abort', () =>
              setTimeout(() => {
                finished = true
                resolve()
              }, 20),
            ),
          ),
      ),
    )
    await postTask(s, 'long job')

    await s.close()
    server = undefined

    expect(finished).toBe(true)
  })

  it('serves the built client without a token, and nothing outside it', async () => {
    await writeFile(path.join(clientDir, 'index.html'), '<!doctype html><title>OpenAgent</title>')
    await mkdir(path.join(clientDir, 'assets'))
    await writeFile(path.join(clientDir, 'assets', 'app-1234.js'), 'console.log(1)')
    await writeFile(path.join(path.dirname(clientDir), `${path.basename(clientDir)}-secret.txt`), 'secret')
    const s = await start()

    const page = await send(s, 'GET', '/')
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(page.body).toContain('OpenAgent')

    const asset = await send(s, 'GET', '/assets/app-1234.js')
    expect(asset.headers['content-type']).toContain('text/javascript')
    expect(asset.headers['cache-control']).toContain('immutable')

    const escape = `/..%2f${path.basename(clientDir)}-secret.txt`
    expect((await send(s, 'GET', escape)).status).toBe(404)
    await rm(path.join(path.dirname(clientDir), `${path.basename(clientDir)}-secret.txt`))
  })

  it('says how to build the client when it has not been built', async () => {
    const s = await start()

    const page = await send(s, 'GET', '/')

    expect(page.status).toBe(503)
    expect(page.body).toContain('npm run build -w @open-agent/web')
  })

  describe('history', () => {
    const saved: SessionEvent[] = [
      { type: 'user/message', taskId: 't-old', at: 1000, message: { role: 'user', content: 'summarize the readme' } },
      { type: 'assistant/message', taskId: 't-old', at: 2000, message: { role: 'assistant', content: 'A CLI agent.' } },
      { type: 'turn/end', taskId: 't-old', at: 2001, reason: 'completed' },
    ]
    const asked: { taskId: string; sessionId?: string }[] = []
    const source: WebServerOptions['history'] = {
      async list() {
        return [
          {
            taskId: 't-old',
            sessionId: 'session_ab12',
            prompt: 'summarize\n the   readme',
            status: 'completed',
            startedAt: 1000,
            endedAt: 2001,
            answer: 'A CLI agent.',
            toolCalls: 0,
          },
        ]
      },
      async events(taskId, sessionId) {
        asked.push({ taskId, sessionId })
        return sessionId === 'session_ab12' ? saved : undefined
      },
    }
    const get = (s: WebServer, path: string) => send(s, 'GET', path, { headers: { Authorization: `Bearer ${TOKEN}` } })

    it('lists past tasks, with the prompt flattened to a preview', async () => {
      const s = await start(undefined, source)

      const reply = await get(s, '/api/history')

      expect(reply.status).toBe(200)
      expect(JSON.parse(reply.body).tasks).toEqual([
        {
          taskId: 't-old',
          sessionId: 'session_ab12',
          prompt: 'summarize the readme',
          status: 'completed',
          startedAt: 1000,
          endedAt: 2001,
          answer: 'A CLI agent.',
          toolCalls: 0,
        },
      ])
    })

    it('returns one task with its transcript replayed as stream events', async () => {
      const s = await start(undefined, source)

      const reply = await get(s, '/api/history/t-old?session=session_ab12')
      const body = JSON.parse(reply.body)

      expect(reply.status).toBe(200)
      expect(body.task).toMatchObject({ taskId: 't-old', status: 'completed' })
      expect(body.events.map((event: { type: string }) => event.type)).toEqual([
        'task/start',
        'text',
        'text',
        'task/end',
      ])
    })

    it('needs the token, like the rest of the API', async () => {
      const s = await start(undefined, source)

      expect((await send(s, 'GET', '/api/history')).status).toBe(401)
      expect((await send(s, 'GET', '/api/history/t-old')).status).toBe(401)
    })

    it('refuses ids that are not the shape the runtime makes, before asking the store', async () => {
      const s = await start(undefined, source)
      asked.length = 0

      const traversal = await get(s, '/api/history/t-old?session=..%2F..%2Fetc')
      const badTask = await get(s, '/api/history/..%2Fx')

      expect(traversal.status).toBe(400)
      expect(badTask.status).toBe(400)
      expect(asked).toEqual([])
    })

    it('says so when the task does not exist, or history is not available', async () => {
      const withHistory = await start(undefined, source)
      expect((await get(withHistory, '/api/history/nope')).status).toBe(404)
      await withHistory.close()

      const without = await start()
      expect((await get(without, '/api/history')).status).toBe(404)
    })
  })

  describe('approvals', () => {
    /** A task that asks for approval once, then reports what it was told. */
    function askingTask(request: Partial<ApprovalRequest> = {}) {
      const answers: ApprovalAnswer[] = []
      let ask!: (r: ApprovalRequest) => Promise<ApprovalAnswer>
      const runTask: RunTask = async () => {
        const answer = await ask({
          tool: 'write_file',
          level: 'ask',
          args: { path: 'report.md', content: '# Report' },
          scopes: ['once', 'task', 'session'],
          ...request,
        })
        answers.push(answer)
        return { status: 'completed', answer: answer.approved ? 'wrote it' : 'did not write it' }
      }
      return { runTask, answers, bind: (s: WebServer) => (ask = s.requestApproval) }
    }
    const answer = (s: WebServer, approvalId: string, body: unknown) =>
      send(s, 'POST', `/api/approvals/${approvalId}`, { headers: auth, body: JSON.stringify(body) })
    const nextRequest = (s: WebServer) => collect(s, (event) => event.type === 'approval/request')

    it('puts the call in front of the page and runs it with the scope chosen', async () => {
      const task = askingTask()
      const s = await start(task.runTask)
      task.bind(s)

      await postTask(s, 'write the report')
      const request = (await nextRequest(s)).at(-1) as Extract<ServerEvent, { type: 'approval/request' }>
      expect(request).toMatchObject({ tool: 'write_file', level: 'ask', scopes: ['once', 'task', 'session'] })
      expect(request.args).toContain('"path": "report.md"')

      expect((await answer(s, request.approvalId, { approved: true, scope: 'task' })).status).toBe(200)
      const events = await collect(s, (event) => event.type === 'task/end')

      expect(task.answers).toEqual([{ approved: true, scope: 'task' }])
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'approval/resolved', approved: true, scope: 'task' }),
      )
    })

    it('refuses a scope the call was not offered, so the page cannot widen it', async () => {
      const task = askingTask({ level: 'dangerous', scopes: ['once'] })
      const s = await start(task.runTask)
      task.bind(s)

      await postTask(s, 'go')
      const request = (await nextRequest(s)).at(-1) as Extract<ServerEvent, { type: 'approval/request' }>

      expect((await answer(s, request.approvalId, { approved: true, scope: 'session' })).status).toBe(400)
      expect(task.answers).toEqual([])
      expect((await answer(s, request.approvalId, { approved: false })).status).toBe(200)
      await collect(s, (event) => event.type === 'task/end')
      expect(task.answers).toEqual([{ approved: false }])
    })

    it('takes the first answer and refuses a second, as when two tabs answer', async () => {
      const task = askingTask()
      const s = await start(task.runTask)
      task.bind(s)

      await postTask(s, 'go')
      const request = (await nextRequest(s)).at(-1) as Extract<ServerEvent, { type: 'approval/request' }>

      expect((await answer(s, request.approvalId, { approved: false })).status).toBe(200)
      expect((await answer(s, request.approvalId, { approved: true })).status).toBe(404)
      await collect(s, (event) => event.type === 'task/end')
      expect(task.answers).toEqual([{ approved: false }])
    })

    it('shows a pending question to a tab that connects while it waits', async () => {
      const task = askingTask({ escalation: { rule: 'exfiltration-after-ingest', reason: 'new host' } })
      const s = await start(task.runTask)
      task.bind(s)

      await postTask(s, 'go')
      await nextRequest(s)
      const late = await nextRequest(s)

      expect(late.at(-1)).toMatchObject({ type: 'approval/request', escalation: { reason: 'new host' } })
    })

    it('denies a waiting question when the task is stopped, so the stop goes through', async () => {
      const task = askingTask()
      const s = await start(task.runTask)
      task.bind(s)

      const { taskId } = JSON.parse((await postTask(s, 'go')).body) as { taskId: string }
      await nextRequest(s)
      await send(s, 'POST', `/api/tasks/${taskId}/cancel`, { headers: auth, body: '{}' })
      await collect(s, (event) => event.type === 'task/end')

      expect(task.answers).toEqual([{ approved: false }])
    })

    it('denies at once when no task is running, and when the server closes', async () => {
      const idle = await start()
      expect(await idle.requestApproval({ tool: 'x', level: 'ask', args: {}, scopes: ['once'] })).toEqual({
        approved: false,
      })
      await idle.close()

      const task = askingTask()
      const s = await start(task.runTask)
      task.bind(s)
      await postTask(s, 'go')
      await nextRequest(s)

      await s.close()
      server = undefined

      expect(task.answers).toEqual([{ approved: false }])
    })
  })
})
