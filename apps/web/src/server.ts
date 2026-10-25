import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { taskRecords } from '@open-agent/agent'
import type { RunTextEvent, SessionEvent, TaskRecord, TokenUsage, ToolAttachment } from '@open-agent/agent'
import type {
  ApprovalScope,
  HistoryTask,
  HistoryTranscript,
  MemoryListing,
  MemoryRecord,
  ProfileAction,
  ProfileFields,
  ProfilesView,
  ServerEvent,
  SettingsGroup,
  SettingsView,
  TaskEndStatus,
} from './protocol.js'
import { activityProjector, clip, preview, replayTask } from './project.js'

/** Where `vite build` puts the client. */
export const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/client')

export interface TaskOutcome {
  status: TaskEndStatus
  /** The model's final answer. Empty unless the task completed. */
  answer: string
  error?: string
  usage?: TokenUsage
}

export interface TaskHooks {
  onText(event: RunTextEvent): void
  /** This task's session events, as they are appended. */
  onEvent(event: SessionEvent): void
  /** What tools show while they run; see `RunOptions.onAttachment`. */
  onAttachment(attachment: ToolAttachment): void
}

/**
 * Runs one task to the end. Injected rather than built here so the browser
 * gets exactly the task the terminal does — memory recall, the session log,
 * approvals — from the host that already assembled them.
 */
export type RunTask = (input: string, signal: AbortSignal, hooks: TaskHooks) => Promise<TaskOutcome>

/**
 * Past tasks, from wherever the host keeps them: saved sessions and the one
 * running now. Injected, like `runTask`, so the page lists exactly what
 * `:history` does in the terminal.
 */
export interface HistorySource {
  /** Recent tasks, newest first. */
  list(): Promise<TaskRecord[]>
  /** The events of one task, from the named saved session or, without one, the live session. */
  events(taskId: string, sessionId?: string): Promise<SessionEvent[] | undefined>
}

/**
 * The agent's long-term memory for the person using this server, from the
 * host that configured it. Each call is already scoped to their container,
 * so the page can only reach its own user's memories.
 */
export interface MemorySource {
  provider: string
  containerTag: string
  /** Absent when the backend cannot list everything; the page searches instead. */
  list?(limit: number): Promise<MemoryRecord[]>
  search(query: string, limit: number): Promise<MemoryRecord[]>
  forget(id: string): Promise<boolean>
  /** `false` when the backend could not apply it — some cannot edit at all. */
  update(id: string, content: string): Promise<boolean>
}

/**
 * The host's configuration, as far as the settings view may see and change
 * it. The host decides which settings exist and where they are written; a
 * secret's value is never part of what `read()` returns.
 */
export interface SettingsSource {
  envPath: string
  /** Where new keys go: a keychain's name, or `.env`. */
  secretStore: string
  read(): SettingsGroup[]
  /** Names to new values, `null` to remove. Validated as a whole; nothing is written when it fails. */
  apply(changes: Record<string, string | null>): { ok: true } | { ok: false; error: string }
}

/**
 * The host's agent profiles. As with settings, the host owns every rule —
 * which tools the page may turn on, where files go — and the server only
 * checks that a request has the right shape before passing it on.
 */
export interface ProfilesSource {
  read(): Omit<ProfilesView, 'restartNeeded'>
  /** `restartNeeded` when the change reaches the running agent only through a restart. */
  apply(action: ProfileAction): { ok: true; restartNeeded: boolean } | { ok: false; error: string }
}

export interface WebServerOptions {
  runTask: RunTask
  /** Enables the settings view; without it `/api/settings` answers 404. */
  settings?: SettingsSource
  /** Enables the profiles view; without it `/api/profiles` answers 404. */
  profiles?: ProfilesSource
  /** Enables the memory view; without it `/api/memory` answers 404. */
  memory?: MemorySource
  /** Enables the history view; without it `/api/history` answers 404. */
  history?: HistorySource
  /** `0` takes any free port. */
  port: number
  /** Generated when absent. Fixed only by tests. */
  token?: string
  clientDir?: string
}

/** A tool call the registry wants a person to decide on; see `ApprovalHandler`. */
export interface ApprovalRequest {
  tool: string
  level: 'safe' | 'ask' | 'dangerous'
  args: Record<string, unknown>
  /** From `approvalScopes`: what the page may offer, and all the server will accept. */
  scopes: ApprovalScope[]
  escalation?: { rule: string; reason: string }
  planPreview?: string
}

export interface ApprovalAnswer {
  approved: boolean
  scope?: ApprovalScope
}

export interface WebServer {
  /** The address to open, token included. */
  url: string
  port: number
  notice(text: string): void
  /**
   * Puts a tool call in front of the person in the browser and resolves with
   * their answer. Denied straight away when no task is running to attach it
   * to, and when the task is stopped or the server closes while it waits:
   * the agent is never left waiting on a question nobody can see.
   */
  requestApproval(request: ApprovalRequest): Promise<ApprovalAnswer>
  /** Cancels a running task and waits for it, so the session log is complete once this resolves. */
  close(): Promise<void>
}

const MAX_BODY_BYTES = 64 * 1024
/** Enough for any command or edit a person would actually read before approving it. */
const APPROVAL_ARGS_LENGTH = 4_000
const PLAN_LENGTH = 20_000
const SCREEN_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
/** About 3 MB of image: more than a full-page screenshot needs. */
const MAX_SCREEN_CHARS = 4_000_000
const MAX_REPLAYED_SCREENS = 5
const MEMORY_LIST_LIMIT = 200
const MEMORY_SEARCH_LIMIT = 50
const MEMORY_CONTENT_LENGTH = 10_000
/** Enough to rebuild a long conversation on reload, not enough to grow without bound. */
const MAX_REPLAY_EVENTS = 2000
/** Under the idle timeout of anything that might sit between a browser and localhost. */
const KEEPALIVE_MS = 15_000

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

/** No inline script or style, nothing from elsewhere, and never framed — the page drives an agent with a shell. */
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

function toHistoryTask(record: TaskRecord): HistoryTask {
  return {
    taskId: record.taskId,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    prompt: preview(record.prompt),
    status: record.status,
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.answer ? { answer: preview(record.answer) } : {}),
    toolCalls: record.toolCalls,
    ...(record.usage ? { usage: record.usage } : {}),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The request as a `ProfileAction`, or `null` when it has the wrong shape. The host judges the values. */
function toProfileAction(body: Record<string, unknown>): ProfileAction | null {
  const { action, id } = body
  if (action === 'default') return id === null || typeof id === 'string' ? { action, id } : null
  if (typeof id !== 'string') return null
  if (action === 'delete') return { action, id }
  if (action === 'duplicate') return typeof body.newId === 'string' ? { action, id, newId: body.newId } : null
  if (action !== 'save' || typeof body.create !== 'boolean' || !isRecord(body.profile)) return null
  const { name, model, tools } = body.profile
  if (typeof name !== 'string' || typeof model !== 'string' || !isRecord(tools)) return null
  if (!Object.values(tools).every((enabled) => typeof enabled === 'boolean')) return null
  return { action, id, create: body.create, profile: { name, model, tools: tools as ProfileFields['tools'] } }
}

function sameToken(given: string | null, expected: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...PAGE_HEADERS })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Serves the chat UI and the API behind it on 127.0.0.1, for one person at
 * the machine. One task runs at a time, as in the terminal; every open tab
 * sees the same conversation.
 *
 * The agent behind this can have a shell, so the server assumes the browser
 * running it also has other sites open and defends against them:
 *
 * - Every API call carries a token printed in the terminal at startup. A page
 *   on another site can send requests to localhost but cannot read the URL.
 * - The `Host` header must name this server. A site that rebinds its own
 *   domain to 127.0.0.1 is same-origin with itself, not with us, and its
 *   requests still say its own name.
 * - POSTs must be JSON from no origin or our own. JSON forces a CORS
 *   preflight, which this server never answers, so a cross-site form or
 *   `fetch` cannot reach the handler at all.
 */
export async function startWebServer({
  runTask,
  port,
  token = randomBytes(24).toString('base64url'),
  clientDir: givenClientDir = CLIENT_DIR,
  history,
  memory,
  profiles,
  settings,
}: WebServerOptions): Promise<WebServer> {
  const clientDir = path.resolve(givenClientDir)
  const clients = new Set<ServerResponse>()
  const replay: ServerEvent[] = []
  let current: { taskId: string; controller: AbortController; done: Promise<void> } | null = null
  // The reply being streamed right now. Deltas go to open tabs as they come
  // but are not replayed one by one: a finished reply is recorded once, whole,
  // and a tab that connects mid-reply is sent what has arrived so far.
  let streaming = ''
  // The latest picture of the running task, for a tab that connects mid-task.
  // Frames are not replayed one by one: they are many, large, and only the
  // newest says what is on screen now.
  let screen: Extract<ServerEvent, { type: 'screen' }> | undefined

  const broadcast = (event: ServerEvent) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`
    for (const res of clients) res.write(frame)
  }
  const record = (event: ServerEvent) => {
    replay.push(event)
    if (replay.length > MAX_REPLAY_EVENTS) replay.splice(0, replay.length - MAX_REPLAY_EVENTS)
  }
  const emit = (event: ServerEvent) => {
    record(event)
    broadcast(event)
  }
  const notice = (text: string) => {
    const trimmed = text.trim()
    if (trimmed) emit({ type: 'notice', text: trimmed })
  }

  function startTask(input: string): string {
    const taskId = randomUUID()
    const controller = new AbortController()
    streaming = ''
    emit({ type: 'task/start', taskId, input })

    const hooks: TaskHooks = {
      onText(event) {
        if (event.type === 'delta') {
          streaming += event.text
          broadcast({ type: 'text', taskId, event })
        } else if (event.type === 'reset') {
          streaming = ''
          broadcast({ type: 'text', taskId, event })
        } else {
          if (streaming) record({ type: 'text', taskId, event: { type: 'delta', text: streaming } })
          streaming = ''
          emit({ type: 'text', taskId, event })
        }
      },
      onEvent: activityProjector(taskId, emit),
      onAttachment(attachment) {
        // Only images the page can show, and none so large it would stall
        // every open tab: an image's type comes from a tool's server, which
        // is reporting on a page someone else wrote.
        if (!SCREEN_TYPES.has(attachment.mimeType) || attachment.data.length > MAX_SCREEN_CHARS) return
        screen = {
          type: 'screen',
          taskId,
          mimeType: attachment.mimeType,
          data: attachment.data,
          ...(attachment.caption ? { caption: clip(attachment.caption, 80) } : {}),
        }
        broadcast(screen)
      },
    }

    // Current before the task starts, not after: anything it does
    // synchronously, asking for approval above all, has to find it.
    const task: { taskId: string; controller: AbortController; done: Promise<void> } = {
      taskId,
      controller,
      done: Promise.resolve(),
    }
    current = task
    task.done = runTask(input, controller.signal, hooks)
      .catch((err): TaskOutcome => ({
        status: 'error',
        answer: '',
        error: err instanceof Error ? err.message : String(err),
      }))
      .then((outcome) => {
        streaming = ''
        denyPending(taskId)
        // The last thing the task showed stays with its turn for anyone who
        // opens the page later. Only that one frame, and only for the most
        // recent few tasks: the rest would be megabytes nobody scrolls back to.
        if (screen?.taskId === taskId) {
          const frames = replay.filter((event) => event.type === 'screen')
          for (const old of frames.slice(0, Math.max(0, frames.length - (MAX_REPLAYED_SCREENS - 1)))) {
            replay.splice(replay.indexOf(old), 1)
          }
          record(screen)
        }
        emit({ type: 'task/end', taskId, ...outcome })
      })
      .finally(() => {
        if (current === task) current = null
      })
    return taskId
  }

  const pending = new Map<
    string,
    { taskId: string; scopes: ApprovalScope[]; resolve: (answer: ApprovalAnswer) => void }
  >()

  function requestApproval(request: ApprovalRequest): Promise<ApprovalAnswer> {
    if (!current) return Promise.resolve({ approved: false })
    const { taskId } = current
    const approvalId = randomUUID()
    emit({
      type: 'approval/request',
      taskId,
      approvalId,
      tool: request.tool,
      level: request.level,
      args: clip(JSON.stringify(request.args, null, 2), APPROVAL_ARGS_LENGTH),
      scopes: request.scopes,
      ...(request.escalation ? { escalation: request.escalation } : {}),
      ...(request.planPreview !== undefined ? { planPreview: clip(request.planPreview, PLAN_LENGTH) } : {}),
    })
    return new Promise((resolve) => pending.set(approvalId, { taskId, scopes: request.scopes, resolve }))
  }

  function settle(approvalId: string, answer: ApprovalAnswer): boolean {
    const waiting = pending.get(approvalId)
    if (!waiting) return false
    pending.delete(approvalId)
    waiting.resolve(answer)
    emit({
      type: 'approval/resolved',
      taskId: waiting.taskId,
      approvalId,
      approved: answer.approved,
      ...(answer.approved ? { scope: answer.scope ?? 'once' } : {}),
    })
    return true
  }

  function denyPending(taskId?: string): void {
    for (const [approvalId, waiting] of pending) {
      if (taskId === undefined || waiting.taskId === taskId) settle(approvalId, { approved: false })
    }
  }

  function openStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      ...PAGE_HEADERS,
    })
    const send = (event: ServerEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`)
    send({ type: 'hello' })
    for (const event of replay) send(event)
    if (current && screen?.taskId === current.taskId) send(screen)
    if (current && streaming) send({ type: 'text', taskId: current.taskId, event: { type: 'delta', text: streaming } })
    clients.add(res)
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS)
    req.on('close', () => {
      clearInterval(keepalive)
      clients.delete(res)
    })
  }

  async function serveStatic(res: ServerResponse, pathname: string, head: boolean): Promise<void> {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return sendJson(res, 400, { error: 'Bad path.' })
    }
    const file = path.resolve(clientDir, `.${decoded === '/' ? '/index.html' : decoded}`)
    if (file !== clientDir && !file.startsWith(clientDir + path.sep)) return sendJson(res, 404, { error: 'Not found.' })
    let body: Buffer
    try {
      body = await readFile(file)
    } catch {
      if (decoded === '/') {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', ...PAGE_HEADERS })
        res.end('The web client has not been built. Run `npm run build -w @open-agent/web`, then reload.\n')
        return
      }
      return sendJson(res, 404, { error: 'Not found.' })
    }
    const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream'
    // Vite fingerprints everything under assets/, so those never change;
    // index.html names the current fingerprints and must always be fresh.
    const cache = decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, ...PAGE_HEADERS })
    res.end(head ? undefined : body)
  }

  async function serveHistory(res: ServerResponse, url: URL): Promise<void> {
    if (!history) return sendJson(res, 404, { error: 'History is not available.' })
    if (url.pathname === '/api/history') {
      const tasks: HistoryTask[] = (await history.list()).map(toHistoryTask)
      return sendJson(res, 200, { tasks })
    }
    // Both ids end up naming files in the session store: held to the shapes
    // the runtime generates, so nothing else reaches it.
    const taskId = url.pathname.match(/^\/api\/history\/([A-Za-z0-9_-]{1,128})$/)?.[1]
    const sessionId = url.searchParams.get('session') ?? undefined
    if (!taskId || (sessionId !== undefined && !/^session_[0-9a-f]{1,64}$/.test(sessionId))) {
      return sendJson(res, 400, { error: 'Bad task or session id.' })
    }
    const events = (await history.events(taskId, sessionId))?.filter((event) => event.taskId === taskId) ?? []
    const [record] = taskRecords(events, sessionId)
    if (!record) return sendJson(res, 404, { error: 'No such task.' })
    const transcript: HistoryTranscript = { task: toHistoryTask(record), events: replayTask(taskId, events) }
    return sendJson(res, 200, transcript)
  }

  // The running agent was built from the settings it started with; a saved
  // change reaches it only through a restart, and the page says so.
  let restartNeeded = false

  let origin = ''
  let allowedHosts = new Set<string>()
  let allowedOrigins = new Set<string>()

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowedHosts.has(req.headers.host ?? '')) return sendJson(res, 403, { error: 'Unexpected Host header.' })
    const url = new URL(req.url ?? '/', origin)

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' })
      return serveStatic(res, url.pathname, req.method === 'HEAD')
    }

    // EventSource cannot set headers, so the stream takes the token in the
    // query; everything else sends it as a bearer token.
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? null
    if (!sameToken(bearer ?? url.searchParams.get('token'), token)) {
      return sendJson(res, 401, { error: 'Missing or wrong token. Open the URL printed in the terminal.' })
    }

    if (req.method === 'GET' && url.pathname === '/api/events') return openStream(req, res)
    if (req.method === 'GET' && url.pathname.startsWith('/api/history')) return serveHistory(res, url)
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      if (!settings) return sendJson(res, 404, { error: 'Settings are not available.' })
      const view: SettingsView = {
        envPath: settings.envPath,
        secretStore: settings.secretStore,
        groups: settings.read(),
        restartNeeded,
      }
      return sendJson(res, 200, view)
    }
    if (req.method === 'GET' && url.pathname === '/api/profiles') {
      if (!profiles) return sendJson(res, 404, { error: 'Profiles are not available.' })
      const view: ProfilesView = { ...profiles.read(), restartNeeded }
      return sendJson(res, 200, view)
    }
    if (req.method === 'GET' && url.pathname === '/api/memory') {
      if (!memory) return sendJson(res, 404, { error: 'Memory is not available.' })
      const query = url.searchParams.get('q')?.trim() ?? ''
      const items = query
        ? await memory.search(query, MEMORY_SEARCH_LIMIT)
        : memory.list
          ? await memory.list(MEMORY_LIST_LIMIT)
          : []
      const listing: MemoryListing = {
        provider: memory.provider,
        containerTag: memory.containerTag,
        canList: Boolean(memory.list),
        query,
        items,
      }
      return sendJson(res, 200, listing)
    }
    if (req.method !== 'POST') return sendJson(res, 404, { error: 'Not found.' })

    const requestOrigin = req.headers.origin
    if (requestOrigin !== undefined && !allowedOrigins.has(requestOrigin)) {
      return sendJson(res, 403, { error: 'Cross-origin request refused.' })
    }
    if (!req.headers['content-type']?.startsWith('application/json')) {
      return sendJson(res, 415, { error: 'Send JSON.' })
    }

    const raw = await readBody(req)
    if (raw === null) return sendJson(res, 413, { error: 'Request too large.' })
    let body: Record<string, unknown>
    try {
      body = (JSON.parse(raw || '{}') ?? {}) as Record<string, unknown>
    } catch {
      return sendJson(res, 400, { error: 'Body is not JSON.' })
    }

    if (url.pathname === '/api/tasks') {
      const input = body.input
      if (typeof input !== 'string' || !input.trim()) return sendJson(res, 400, { error: 'Give the task as "input".' })
      if (current) return sendJson(res, 409, { error: 'A task is already running. Wait for it, or stop it.' })
      return sendJson(res, 202, { taskId: startTask(input.trim()) })
    }

    const cancel = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/)
    if (cancel) {
      if (!current || current.taskId !== cancel[1]) return sendJson(res, 404, { error: 'No such running task.' })
      current.controller.abort()
      // Before the abort can take effect the loop may be parked on a
      // question; answering it is what lets the cancellation through.
      denyPending(current.taskId)
      return sendJson(res, 202, {})
    }

    if (url.pathname === '/api/settings') {
      if (!settings) return sendJson(res, 404, { error: 'Settings are not available.' })
      const changes = body.changes
      const valid =
        changes !== null &&
        typeof changes === 'object' &&
        !Array.isArray(changes) &&
        Object.values(changes).every((value) => value === null || typeof value === 'string')
      if (!valid) return sendJson(res, 400, { error: 'Send "changes": names to strings, or null to remove.' })
      const result = settings.apply(changes as Record<string, string | null>)
      if (!result.ok) return sendJson(res, 400, { error: result.error })
      restartNeeded = true
      return sendJson(res, 200, { restartNeeded })
    }

    if (url.pathname === '/api/profiles') {
      if (!profiles) return sendJson(res, 404, { error: 'Profiles are not available.' })
      const action = toProfileAction(body)
      if (!action) return sendJson(res, 400, { error: 'Send an "action": save, duplicate, delete or default.' })
      const result = profiles.apply(action)
      if (!result.ok) return sendJson(res, 400, { error: result.error })
      if (result.restartNeeded) restartNeeded = true
      return sendJson(res, 200, { restartNeeded })
    }

    const memoryPath = url.pathname.match(/^\/api\/memory\/([^/]+?)(\/forget)?$/)
    if (memoryPath) {
      if (!memory) return sendJson(res, 404, { error: 'Memory is not available.' })
      let id = ''
      try {
        id = decodeURIComponent(memoryPath[1])
      } catch {
        // A malformed escape is a bad id, answered as one below.
      }
      if (!/^[\w.:-]{1,200}$/.test(id)) return sendJson(res, 400, { error: 'Bad memory id.' })
      if (memoryPath[2]) {
        return (await memory.forget(id))
          ? sendJson(res, 200, {})
          : sendJson(res, 404, { error: 'No such memory, or it was already forgotten.' })
      }
      const content = body.content
      if (typeof content !== 'string' || !content.trim() || content.length > MEMORY_CONTENT_LENGTH) {
        return sendJson(res, 400, {
          error: `Give the new text as "content", up to ${MEMORY_CONTENT_LENGTH} characters.`,
        })
      }
      return (await memory.update(id, content.trim()))
        ? sendJson(res, 200, {})
        : sendJson(res, 409, { error: `The ${memory.provider} memory provider did not apply the edit.` })
    }

    const approval = url.pathname.match(/^\/api\/approvals\/([^/]+)$/)
    if (approval) {
      const waiting = pending.get(approval[1])
      if (!waiting) return sendJson(res, 404, { error: 'That approval was already answered, or its task ended.' })
      if (typeof body.approved !== 'boolean') return sendJson(res, 400, { error: 'Send "approved": true or false.' })
      const scope = (body.scope ?? 'once') as ApprovalScope
      // The page only shows the scopes it was offered, but the server is what
      // the registry trusts: a request for a wider one is refused here.
      if (body.approved && !waiting.scopes.includes(scope)) {
        return sendJson(res, 400, { error: `"${String(scope)}" is not on offer for this call.` })
      }
      settle(approval[1], body.approved ? { approved: true, scope } : { approved: false })
      return sendJson(res, 200, {})
    }
    return sendJson(res, 404, { error: 'Not found.' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      else res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Loopback only. Anything wider would hand the agent to the network.
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const bound = (server.address() as AddressInfo).port
  origin = `http://127.0.0.1:${bound}`
  allowedHosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`])
  allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`))

  return {
    url: `${origin}/?token=${token}`,
    port: bound,
    notice,
    requestApproval,
    async close() {
      const running = current
      running?.controller.abort()
      denyPending()
      await running?.done
      for (const res of clients) res.end()
      clients.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    },
  }
}
