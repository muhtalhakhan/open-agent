import { describe, expect, it } from 'vitest'
import { JobQueue } from './queue.js'
import { notifyOnFinish, streamNotifier, webhookNotifier, type Notification } from './notify.js'

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function collecting() {
  const received: Notification[] = []
  return { received, notifier: (n: Notification) => void received.push(n) }
}

describe('notifyOnFinish', () => {
  it('reports successes and failures, with the result or the error as the body', async () => {
    const queue = new JobQueue({
      executor: async (job) => {
        if (job.name === 'bad') throw new Error('model unavailable')
        return 'Inbox: 3 unread, 1 urgent.'
      },
    })
    const { received, notifier } = collecting()
    notifyOnFinish(queue, notifier, { now: () => 7 })

    await queue.wait(queue.enqueue({ name: 'digest', prompt: 'summarize' }).id)
    await queue.wait(queue.enqueue({ name: 'bad', prompt: 'x' }).id)

    expect(received).toMatchObject([
      {
        name: 'digest',
        status: 'succeeded',
        title: 'Job "digest" finished',
        body: 'Inbox: 3 unread, 1 urgent.',
        at: 7,
      },
      { name: 'bad', status: 'failed', title: 'Job "bad" failed', body: 'model unavailable' },
    ])
  })

  it('stays quiet about retries and cancellations unless asked', async () => {
    let calls = 0
    const queue = new JobQueue({
      executor: async () => {
        if (++calls === 1) throw new Error('transient')
      },
      retry: { maxAttempts: 2, backoffMs: 0 },
    })
    const { received, notifier } = collecting()
    notifyOnFinish(queue, notifier)

    await queue.wait(queue.enqueue({ name: 'flaky', prompt: 'x' }).id)
    const queued = queue.enqueue({ name: 'waiting', prompt: 'y' })
    queue.cancel(queued.id)

    expect(received.map((n) => [n.name, n.status, n.title])).toEqual([
      ['flaky', 'succeeded', 'Job "flaky" finished after 2 attempts'],
    ])
  })

  it('reports cancellations when they are asked for', () => {
    const queue = new JobQueue({ executor: () => new Promise(() => {}) })
    const { received, notifier } = collecting()
    notifyOnFinish(queue, notifier, { on: ['cancelled'] })

    queue.enqueue({ name: 'busy', prompt: 'x' })
    queue.cancel(queue.enqueue({ name: 'dropped', prompt: 'y' }).id)

    expect(received.map((n) => n.title)).toEqual(['Job "dropped" was cancelled'])
  })

  it('trims a long result', async () => {
    const queue = new JobQueue({ executor: async () => 'x'.repeat(2_000) })
    const { received, notifier } = collecting()
    notifyOnFinish(queue, notifier)
    await queue.wait(queue.enqueue({ name: 'long', prompt: 'x' }).id)
    expect(received[0].body).toHaveLength(500)
    expect(received[0].body.endsWith('…')).toBe(true)
  })

  it('carries the scheduled task a job came from', async () => {
    const queue = new JobQueue({ executor: async () => {} })
    const { received, notifier } = collecting()
    notifyOnFinish(queue, notifier)
    await queue.wait(queue.enqueue({ name: 'a', prompt: 'x', source: { taskId: 'standup', firedAt: 9 } }).id)
    expect(received[0].source).toEqual({ taskId: 'standup', firedAt: 9 })
  })

  it('keeps the queue running when a notifier throws or rejects, and logs it', async () => {
    const errors: string[] = []
    const logger = { info() {}, warn() {}, error: (event: string) => void errors.push(event) }
    const queue = new JobQueue({ executor: async () => {} })
    notifyOnFinish(
      queue,
      () => {
        throw new Error('sync')
      },
      { logger },
    )
    notifyOnFinish(
      queue,
      async () => {
        throw new Error('async')
      },
      { logger },
    )

    const job = await queue.wait(queue.enqueue({ name: 'a', prompt: 'x' }).id)
    await flush()

    expect(job.status).toBe('succeeded')
    expect(errors).toEqual(['notify/failed', 'notify/failed'])
  })

  it('stops notifying once unsubscribed', async () => {
    const queue = new JobQueue({ executor: async () => {} })
    const { received, notifier } = collecting()
    const stop = notifyOnFinish(queue, notifier)
    stop()
    await queue.wait(queue.enqueue({ name: 'a', prompt: 'x' }).id)
    expect(received).toEqual([])
  })
})

describe('streamNotifier', () => {
  it('writes a status line, with the body indented beneath it', () => {
    const lines: string[] = []
    const notify = streamNotifier((text) => void lines.push(text))
    notify({
      jobId: 'j',
      name: 'a',
      status: 'failed',
      title: 'Job "a" failed',
      body: 'line one\nline two',
      at: 0,
      attempts: 1,
    })
    notify({ jobId: 'k', name: 'b', status: 'succeeded', title: 'Job "b" finished', body: '', at: 0, attempts: 1 })
    expect(lines).toEqual(['[failed] Job "a" failed\n  line one\n  line two\n', '[succeeded] Job "b" finished\n'])
  })
})

describe('webhookNotifier', () => {
  const notification: Notification = {
    jobId: 'j',
    name: 'digest',
    status: 'succeeded',
    title: 'Job "digest" finished',
    body: 'done',
    at: 1,
    attempts: 1,
  }

  it('POSTs the notification as JSON with the configured headers', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    await webhookNotifier({ url: 'https://hooks.example/abc', headers: { authorization: 'Bearer t' }, fetchFn })(
      notification,
    )

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://hooks.example/abc')
    expect(requests[0].init.method).toBe('POST')
    expect(requests[0].init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer t' })
    expect(JSON.parse(requests[0].init.body as string)).toEqual(notification)
  })

  it('rejects when the endpoint answers with an error status', async () => {
    const fetchFn = (async () =>
      new Response(null, { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch
    await expect(webhookNotifier({ url: 'https://hooks.example/abc', fetchFn })(notification)).rejects.toThrow(
      /500 Server Error/,
    )
  })
})
