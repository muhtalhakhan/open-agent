import type { Logger } from '@open-agent/agent'
import { silentLogger } from '@open-agent/agent'
import type { Job, JobQueue, JobStatus } from './queue.js'

/** How much of a job's result a notification carries. */
const BODY_LIMIT = 500

/** A job reached an outcome someone asked to hear about. */
export interface Notification {
  jobId: string
  /** The job's name, as it was queued. */
  name: string
  status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>
  /** One line, suitable for a desktop toast or a log. */
  title: string
  /** The job's result or error, trimmed to a few hundred characters. */
  body: string
  at: number
  attempts: number
  /** The scheduled task the job came from, if any. */
  source?: Job['source']
}

/** Delivers a notification somewhere a person will see it. */
export type Notifier = (notification: Notification) => void | Promise<void>

export interface NotifyOptions {
  /**
   * Which outcomes to report (default: `succeeded` and `failed`). Cancelled
   * jobs are left out by default because someone cancelled them, and telling
   * them so is noise.
   */
  on?: Array<Notification['status']>
  logger?: Logger
  now?: () => number
}

const FINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * Sends a notification whenever a job in `queue` finishes with one of the
 * wanted outcomes. Returns a function that stops listening.
 *
 * Only final outcomes are reported: a job that is `retrying` has not failed
 * yet, and announcing each attempt would train people to ignore the
 * notification that matters. A notifier that throws or rejects is logged and
 * otherwise ignored — a webhook being down must not take the queue with it.
 */
export function notifyOnFinish(queue: JobQueue, notifier: Notifier, options: NotifyOptions = {}): () => void {
  const wanted = new Set(options.on ?? ['succeeded', 'failed'])
  const logger = options.logger ?? silentLogger
  const now = options.now ?? (() => Date.now())

  const report = (error: unknown, job: Job) =>
    logger.error('notify/failed', { id: job.id, error: error instanceof Error ? error.message : String(error) })

  return queue.onChange((job) => {
    if (!FINAL.has(job.status) || !wanted.has(job.status as Notification['status'])) return
    try {
      void Promise.resolve(notifier(toNotification(job, now()))).catch((err) => report(err, job))
    } catch (err) {
      report(err, job)
    }
  })
}

function toNotification(job: Job, at: number): Notification {
  const status = job.status as Notification['status']
  const verb = { succeeded: 'finished', failed: 'failed', cancelled: 'was cancelled' }[status]
  const retries = job.attempts > 1 ? ` after ${job.attempts} attempts` : ''
  const detail = status === 'failed' ? (job.error ?? '') : status === 'succeeded' ? (job.result ?? '') : ''
  return {
    jobId: job.id,
    name: job.name,
    status,
    title: `Job "${job.name}" ${verb}${retries}`,
    body: detail.length > BODY_LIMIT ? `${detail.slice(0, BODY_LIMIT - 1)}…` : detail,
    at,
    attempts: job.attempts,
    ...(job.source ? { source: job.source } : {}),
  }
}

/**
 * Writes each notification as a line or two of text — to a terminal, a log
 * file, anything with a `write`.
 */
export function streamNotifier(write: (text: string) => void): Notifier {
  return (notification) => {
    const body = notification.body ? `\n  ${notification.body.replace(/\n/g, '\n  ')}` : ''
    write(`[${notification.status}] ${notification.title}${body}\n`)
  }
}

export interface WebhookNotifierOptions {
  url: string
  /** Extra request headers — an auth token, most often. */
  headers?: Record<string, string>
  /** Injected so tests (and callers with their own HTTP stack) avoid the network. */
  fetchFn?: typeof fetch
  /** Give up on a slow endpoint after this long (default 10 s). */
  timeoutMs?: number
}

/**
 * POSTs each notification as JSON — for Slack/Discord-style incoming
 * webhooks, ntfy, or anything that accepts a JSON body.
 *
 * The body carries the job's result, which is whatever the agent produced, so
 * the URL is the user's own configuration and never something the agent can
 * choose: a notifier is set up by whoever runs the process, not by a tool
 * call.
 */
export function webhookNotifier(options: WebhookNotifierOptions): Notifier {
  const fetchFn = options.fetchFn ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  return async (notification) => {
    const response = await fetchFn(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`webhook answered ${response.status} ${response.statusText}`.trim())
  }
}
