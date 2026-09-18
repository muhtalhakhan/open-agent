import { describe, expect, it } from 'vitest'
import { Context } from '@open-agent/context'
import { SessionLog, type TaskState } from '@open-agent/agent'
import { JobQueue, agentExecutor, type Job, type JobExecutor } from './queue.js'
import { jobQueuePlugin } from './plugin.js'
import { Scheduler } from './scheduler.js'

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * An executor whose jobs finish only when the test says so, so ordering and
 * concurrency can be asserted without racing real work.
 */
function controlledExecutor() {
  const started: string[] = []
  const signals = new Map<string, AbortSignal>()
  const finish = new Map<string, { resolve: () => void; reject: (err: Error) => void }>()
  const executor: JobExecutor = (job, signal) => {
    started.push(job.name)
    signals.set(job.name, signal)
    return new Promise<void>((resolve, reject) => {
      finish.set(job.name, { resolve, reject })
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
  return {
    executor,
    started,
    signals,
    succeed: async (name: string) => {
      finish.get(name)!.resolve()
      await flush()
    },
    fail: async (name: string, message: string) => {
      finish.get(name)!.reject(new Error(message))
      await flush()
    },
  }
}

const statuses = (queue: JobQueue) => Object.fromEntries(queue.list().map((job) => [job.name, job.status]))

describe('JobQueue', () => {
  it('runs one job at a time by default, in arrival order', async () => {
    const exec = controlledExecutor()
    const queue = new JobQueue({ executor: exec.executor })

    queue.enqueue({ name: 'a', prompt: 'first' })
    queue.enqueue({ name: 'b', prompt: 'second' })
    queue.enqueue({ name: 'c', prompt: 'third' })
    expect(exec.started).toEqual(['a'])
    expect(statuses(queue)).toEqual({ a: 'running', b: 'queued', c: 'queued' })

    await exec.succeed('a')
    expect(exec.started).toEqual(['a', 'b'])
    await exec.succeed('b')
    await exec.succeed('c')
    expect(statuses(queue)).toEqual({ a: 'succeeded', b: 'succeeded', c: 'succeeded' })
  })

  it('runs up to `concurrency` jobs side by side', async () => {
    const exec = controlledExecutor()
    const queue = new JobQueue({ executor: exec.executor, concurrency: 2 })

    for (const name of ['a', 'b', 'c']) queue.enqueue({ name, prompt: name })
    expect(exec.started).toEqual(['a', 'b'])

    // Whichever slot frees first takes the next job, not necessarily the oldest runner's.
    await exec.succeed('b')
    expect(exec.started).toEqual(['a', 'b', 'c'])
  })

  it('records a failure and moves on to the next job', async () => {
    const exec = controlledExecutor()
    const queue = new JobQueue({ executor: exec.executor })
    const a = queue.enqueue({ name: 'a', prompt: 'a' })
    queue.enqueue({ name: 'b', prompt: 'b' })

    await exec.fail('a', 'model unavailable')

    expect(queue.get(a.id)).toMatchObject({ status: 'failed', error: 'model unavailable' })
    expect(exec.started).toEqual(['a', 'b'])
  })

  it('treats an executor that throws synchronously as a failed job', async () => {
    const queue = new JobQueue({
      executor: () => {
        throw new Error('boom')
      },
    })
    const job = queue.enqueue({ name: 'a', prompt: 'a' })
    expect(await queue.wait(job.id)).toMatchObject({ status: 'failed', error: 'boom' })
  })

  it('drops a cancelled job before it ever runs', async () => {
    const exec = controlledExecutor()
    const queue = new JobQueue({ executor: exec.executor })
    queue.enqueue({ name: 'a', prompt: 'a' })
    const b = queue.enqueue({ name: 'b', prompt: 'b' })

    expect(queue.cancel(b.id)).toBeDefined()
    await exec.succeed('a')

    expect(exec.started).toEqual(['a'])
    expect(queue.get(b.id)?.status).toBe('cancelled')
  })

  it('aborts a running job and records it as cancelled, not failed', async () => {
    const exec = controlledExecutor()
    const queue = new JobQueue({ executor: exec.executor })
    const a = queue.enqueue({ name: 'a', prompt: 'a' })

    queue.cancel(a.id)
    expect(exec.signals.get('a')?.aborted).toBe(true)

    const done = await queue.wait(a.id)
    expect(done.status).toBe('cancelled')
    expect(done.error).toBeUndefined()
  })

  it('refuses to cancel a job that has already finished', async () => {
    const queue = new JobQueue({ executor: async () => {} })
    const job = queue.enqueue({ name: 'a', prompt: 'a' })
    await queue.wait(job.id)
    expect(queue.cancel(job.id)).toBeUndefined()
    expect(queue.get(job.id)?.status).toBe('succeeded')
  })

  it('resolves wait() for a job that finished before anyone asked', async () => {
    const queue = new JobQueue({ executor: async () => {} })
    const job = queue.enqueue({ name: 'a', prompt: 'a' })
    await flush()
    expect((await queue.wait(job.id)).status).toBe('succeeded')
    await expect(queue.wait('job_missing')).rejects.toThrow(/no job/)
  })

  it('close() cancels what is waiting, stops what is running, and takes no more work', async () => {
    const exec = controlledExecutor()
    const queue = new JobQueue({ executor: exec.executor })
    queue.enqueue({ name: 'a', prompt: 'a' })
    queue.enqueue({ name: 'b', prompt: 'b' })

    await queue.close()

    expect(statuses(queue)).toEqual({ a: 'cancelled', b: 'cancelled' })
    expect(exec.started).toEqual(['a'])
    expect(() => queue.enqueue({ name: 'c', prompt: 'c' })).toThrow(/closed/)
  })

  it('forgets the oldest finished jobs past the history limit', async () => {
    const queue = new JobQueue({ executor: async () => {}, historyLimit: 2 })
    for (const name of ['a', 'b', 'c']) await queue.wait(queue.enqueue({ name, prompt: name }).id)
    expect(queue.list().map((job) => job.name)).toEqual(['b', 'c'])
  })

  it('rejects a duplicate id and a nonsensical concurrency', () => {
    const queue = new JobQueue({ executor: async () => {} })
    queue.enqueue({ id: 'job_1', name: 'a', prompt: 'a' })
    expect(() => queue.enqueue({ id: 'job_1', name: 'b', prompt: 'b' })).toThrow(/already exists/)
    expect(() => new JobQueue({ executor: async () => {}, concurrency: 0 })).toThrow(/positive integer/)
  })
})

/** Timers the test fires by hand, so a backoff never waits on real time. */
function manualTimers() {
  let now = 0
  const pending = new Map<number, { fn: () => void; at: number }>()
  let nextHandle = 1
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const handle = nextHandle++
      pending.set(handle, { fn, at: now + ms })
      return handle
    },
    clearTimer: (handle: unknown) => void pending.delete(handle as number),
    /** Delays of the timers currently armed. */
    get armed() {
      return [...pending.values()].map((timer) => timer.at - now)
    },
    async advance(ms: number) {
      now += ms
      for (const [handle, timer] of [...pending]) {
        if (timer.at > now) continue
        pending.delete(handle)
        timer.fn()
      }
      await flush()
    },
  }
}

/** An executor that fails the first `failures` attempts of every job, then succeeds. */
function flakyExecutor(failures: number, message = 'rate limited') {
  const attempts: number[] = []
  const executor: JobExecutor = async (job) => {
    attempts.push(job.attempts)
    if (job.attempts <= failures) throw new Error(message)
  }
  return { executor, attempts }
}

describe('JobQueue.onChange', () => {
  it('reports every transition, retries included, and stops when unsubscribed', async () => {
    const timers = manualTimers()
    const queue = new JobQueue({
      executor: flakyExecutor(1).executor,
      retry: { maxAttempts: 2, backoffMs: 5 },
      ...timers,
    })
    const seen: string[] = []
    const stop = queue.onChange((job) => seen.push(`${job.status}#${job.attempts}`))

    const { id } = queue.enqueue({ name: 'a', prompt: 'a' })
    await flush()
    await timers.advance(5)
    expect(seen).toEqual(['queued#0', 'running#1', 'retrying#1', 'queued#1', 'running#2', 'succeeded#2'])

    stop()
    queue.retryNow(id) // not failed, so a no-op either way; nothing more is reported
    queue.enqueue({ name: 'b', prompt: 'b' })
    expect(seen).toHaveLength(6)
  })

  it('keeps running when a listener throws', async () => {
    const queue = new JobQueue({ executor: async () => 'done' })
    queue.onChange(() => {
      throw new Error('listener bug')
    })
    const job = await queue.wait(queue.enqueue({ name: 'a', prompt: 'a' }).id)
    expect(job).toMatchObject({ status: 'succeeded', result: 'done' })
  })
})

describe('JobQueue retries', () => {
  it('does not retry unless asked to', async () => {
    const flaky = flakyExecutor(1)
    const queue = new JobQueue({ executor: flaky.executor })
    const job = await queue.wait(queue.enqueue({ name: 'a', prompt: 'a' }).id)
    expect(job).toMatchObject({ status: 'failed', attempts: 1, maxAttempts: 1 })
  })

  it('retries a failed job with exponential backoff until it succeeds', async () => {
    const timers = manualTimers()
    const flaky = flakyExecutor(2)
    const queue = new JobQueue({ executor: flaky.executor, retry: { maxAttempts: 5, backoffMs: 100 }, ...timers })
    const { id } = queue.enqueue({ name: 'a', prompt: 'a' })
    await flush()

    expect(queue.get(id)).toMatchObject({ status: 'retrying', attempts: 1, error: 'rate limited', retryAt: 100 })
    expect(timers.armed).toEqual([100])

    await timers.advance(100)
    expect(queue.get(id)).toMatchObject({ status: 'retrying', attempts: 2 })
    expect(timers.armed).toEqual([200])

    await timers.advance(200)
    expect(queue.get(id)).toMatchObject({ status: 'succeeded', attempts: 3 })
    expect(queue.get(id)?.error).toBeUndefined()
    expect(flaky.attempts).toEqual([1, 2, 3])
  })

  it('gives up as failed once attempts run out', async () => {
    const timers = manualTimers()
    const queue = new JobQueue({
      executor: flakyExecutor(Infinity).executor,
      retry: { maxAttempts: 2, backoffMs: 10 },
      ...timers,
    })
    const { id } = queue.enqueue({ name: 'a', prompt: 'a' })
    await flush()
    await timers.advance(10)

    expect(queue.get(id)).toMatchObject({ status: 'failed', attempts: 2, error: 'rate limited' })
    expect(timers.armed).toEqual([])
  })

  it('caps the backoff', async () => {
    const timers = manualTimers()
    const queue = new JobQueue({
      executor: flakyExecutor(Infinity).executor,
      retry: { maxAttempts: 10, backoffMs: 100, maxBackoffMs: 250 },
      ...timers,
    })
    queue.enqueue({ name: 'a', prompt: 'a' })
    await flush()
    const delays: number[] = []
    for (let i = 0; i < 4; i++) {
      delays.push(...timers.armed)
      await timers.advance(timers.armed[0])
    }
    expect(delays).toEqual([100, 200, 250, 250])
  })

  it('retries only the failures the policy calls retryable', async () => {
    const timers = manualTimers()
    const queue = new JobQueue({
      executor: flakyExecutor(Infinity, 'invalid prompt').executor,
      retry: { maxAttempts: 3, retryable: (error) => /rate limit/.test(error) },
      ...timers,
    })
    const job = await queue.wait(queue.enqueue({ name: 'a', prompt: 'a' }).id)
    expect(job).toMatchObject({ status: 'failed', attempts: 1, error: 'invalid prompt' })
  })

  it("keeps a job's real error when the retryable predicate itself throws", async () => {
    const queue = new JobQueue({
      executor: flakyExecutor(Infinity, 'real failure').executor,
      retry: {
        maxAttempts: 3,
        retryable: () => {
          throw new Error('predicate bug')
        },
      },
    })
    const job = await queue.wait(queue.enqueue({ name: 'a', prompt: 'a' }).id)
    expect(job).toMatchObject({ status: 'failed', error: 'real failure' })
  })

  it("lets a job's own policy override the queue's", async () => {
    const timers = manualTimers()
    const queue = new JobQueue({ executor: flakyExecutor(1).executor, retry: { maxAttempts: 5 }, ...timers })
    const job = await queue.wait(queue.enqueue({ name: 'a', prompt: 'a', retry: { maxAttempts: 1 } }).id)
    expect(job).toMatchObject({ status: 'failed', attempts: 1 })
  })

  it('does not hold a slot while waiting out a backoff', async () => {
    const timers = manualTimers()
    const ran: string[] = []
    const queue = new JobQueue({
      executor: async (job) => {
        ran.push(job.name)
        if (job.name === 'flaky' && job.attempts === 1) throw new Error('transient')
      },
      retry: { maxAttempts: 2, backoffMs: 1000 },
      ...timers,
    })
    queue.enqueue({ name: 'flaky', prompt: 'a' })
    queue.enqueue({ name: 'other', prompt: 'b' })
    await flush()

    expect(ran).toEqual(['flaky', 'other'])
    await timers.advance(1000)
    expect(ran).toEqual(['flaky', 'other', 'flaky'])
  })

  it('cancels a job waiting out its backoff, and close() does too', async () => {
    const timers = manualTimers()
    const queue = new JobQueue({
      executor: flakyExecutor(Infinity).executor,
      retry: { maxAttempts: 3, backoffMs: 50 },
      ...timers,
    })
    const a = queue.enqueue({ name: 'a', prompt: 'a' })
    await flush()
    expect(queue.cancel(a.id)).toBeDefined()
    expect(queue.get(a.id)).toMatchObject({ status: 'cancelled', retryAt: undefined })

    const b = queue.enqueue({ name: 'b', prompt: 'b' })
    await flush()
    expect(queue.get(b.id)?.status).toBe('retrying')
    await queue.close()
    expect(queue.get(b.id)?.status).toBe('cancelled')
    expect(timers.armed).toEqual([])
  })

  it('only reports a failure to the scheduler once retries are spent', async () => {
    const timers = manualTimers()
    const flaky = flakyExecutor(1)
    const queue = new JobQueue({ executor: flaky.executor, retry: { maxAttempts: 2, backoffMs: 10 }, ...timers })
    const run = queue.runner()(
      {
        task: {
          id: 't',
          name: 't',
          prompt: 'p',
          trigger: { kind: 'at' },
          status: 'running',
          createdAt: 0,
          runCount: 0,
        },
        firedAt: 0,
      },
      new AbortController().signal,
    )
    await flush()
    await timers.advance(10)
    await expect(run).resolves.toBeUndefined()
    expect(flaky.attempts).toEqual([1, 2])
  })

  it('retryNow() gives a failed job one more immediate attempt', async () => {
    const flaky = flakyExecutor(1)
    const queue = new JobQueue({ executor: flaky.executor })
    const { id } = queue.enqueue({ name: 'a', prompt: 'a' })
    expect((await queue.wait(id)).status).toBe('failed')

    // With a free slot the retry starts at once rather than sitting in line.
    expect(queue.retryNow(id)).toMatchObject({ status: 'running', maxAttempts: 2 })
    expect(await queue.wait(id)).toMatchObject({ status: 'succeeded', attempts: 2 })
    expect(queue.retryNow(id)).toBeUndefined()
  })

  it('rejects a nonsensical retry policy', () => {
    const queue = new JobQueue({ executor: async () => {} })
    expect(() => queue.enqueue({ name: 'a', prompt: 'a', retry: { maxAttempts: 0 } })).toThrow(/maxAttempts/)
    expect(() => queue.enqueue({ name: 'a', prompt: 'a', retry: { backoffMs: -1 } })).toThrow(/negative/)
  })
})

describe('JobQueue.runner', () => {
  it('sends fired tasks through the queue and records where each job came from', async () => {
    const jobs: Job[] = []
    const queue = new JobQueue({ executor: async (job) => void jobs.push(job) })
    const scheduler = new Scheduler({
      runner: queue.runner(),
      now: () => 5_000,
      setTimer: () => 0,
      clearTimer: () => {},
    })
    await scheduler.start()

    await scheduler.add({ id: 'digest', name: 'digest', prompt: 'summarize', trigger: { kind: 'at', at: 5_000 } })

    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ prompt: 'summarize', source: { taskId: 'digest', firedAt: 5_000 } })
    expect(scheduler.get('digest')?.status).toBe('done')
    await scheduler.stop()
  })

  it("surfaces a failed job as the scheduled task's error", async () => {
    const queue = new JobQueue({
      executor: async () => {
        throw new Error('rate limited')
      },
    })
    const scheduler = new Scheduler({
      runner: queue.runner(),
      now: () => 5_000,
      setTimer: () => 0,
      clearTimer: () => {},
    })
    await scheduler.start()

    await scheduler.add({ id: 't', name: 't', prompt: 'p', trigger: { kind: 'at', at: 5_000 } })

    expect(scheduler.get('t')).toMatchObject({ status: 'failed', lastError: 'rate limited' })
    await scheduler.stop()
  })

  it("holds the scheduler's run open while the job waits for a slot", async () => {
    const exec = controlledExecutor()
    const queue = new JobQueue({ executor: exec.executor })
    queue.enqueue({ name: 'busy', prompt: 'occupies the only slot' })

    const run = queue.runner()(
      {
        task: {
          id: 't',
          name: 'scheduled',
          prompt: 'p',
          trigger: { kind: 'at' },
          status: 'running',
          createdAt: 0,
          runCount: 0,
        },
        firedAt: 0,
      },
      new AbortController().signal,
    )
    let settled = false
    void run.then(() => (settled = true))

    await flush()
    expect(settled).toBe(false)
    await exec.succeed('busy')
    await exec.succeed('scheduled')
    expect(settled).toBe(true)
  })

  it('cancels the job when the scheduler aborts the run', async () => {
    const exec = controlledExecutor()
    const queue = new JobQueue({ executor: exec.executor })
    const controller = new AbortController()

    const run = queue.runner()(
      {
        task: {
          id: 't',
          name: 'scheduled',
          prompt: 'p',
          trigger: { kind: 'at' },
          status: 'running',
          createdAt: 0,
          runCount: 0,
        },
        firedAt: 0,
      },
      controller.signal,
    )
    controller.abort()
    await run

    expect(queue.list()[0].status).toBe('cancelled')
  })
})

describe('agentExecutor', () => {
  const loopReturning = (status: TaskState['status'], error?: string) => {
    const calls: Array<{ input: string; taskId: string }> = []
    return {
      calls,
      loop: {
        run: async (input: string, _signal: AbortSignal, taskId = 'unused'): Promise<TaskState> => {
          calls.push({ input, taskId })
          return { id: taskId, status, createdAt: 0, updatedAt: 0, error }
        },
      },
    }
  }

  it('runs each retry as its own turn, so a failed attempt is not replayed into the next', async () => {
    let calls = 0
    const taskIds: string[] = []
    const loop = {
      run: async (_input: string, _signal: AbortSignal, taskId = 'unused'): Promise<TaskState> => {
        taskIds.push(taskId)
        calls++
        return { id: taskId, status: calls === 1 ? 'error' : 'completed', createdAt: 0, updatedAt: 0, error: 'flaky' }
      },
    }
    const queue = new JobQueue({ executor: agentExecutor(loop), retry: { maxAttempts: 2, backoffMs: 0 } })
    const job = queue.enqueue({ name: 'a', prompt: 'a' })
    expect((await queue.wait(job.id)).status).toBe('succeeded')
    expect(taskIds).toEqual([job.id, `${job.id}.2`])
  })

  it("takes the job's result from the run's final answer when given the session log", async () => {
    const sessions = new SessionLog()
    const loop = {
      run: async (input: string, _signal: AbortSignal, taskId = 'unused'): Promise<TaskState> => {
        sessions.append({ type: 'user/message', taskId, at: 0, message: { role: 'user', content: input } })
        sessions.append({ type: 'assistant/message', taskId, at: 0, message: { role: 'assistant', content: '42' } })
        return { id: taskId, status: 'completed', createdAt: 0, updatedAt: 0 }
      },
    }
    const queue = new JobQueue({ executor: agentExecutor(loop, sessions) })
    expect((await queue.wait(queue.enqueue({ name: 'a', prompt: 'meaning?' }).id)).result).toBe('42')
  })

  it('runs the prompt as a turn keyed by the job id', async () => {
    const { loop, calls } = loopReturning('completed')
    const queue = new JobQueue({ executor: agentExecutor(loop) })
    const job = queue.enqueue({ name: 'a', prompt: 'do the thing' })

    expect((await queue.wait(job.id)).status).toBe('succeeded')
    expect(calls).toEqual([{ input: 'do the thing', taskId: job.id }])
  })

  it("maps the loop's error and cancelled outcomes onto the job", async () => {
    const failing = new JobQueue({ executor: agentExecutor(loopReturning('error', 'exceeded maxSteps').loop) })
    const failed = await failing.wait(failing.enqueue({ name: 'a', prompt: 'a' }).id)
    expect(failed).toMatchObject({ status: 'failed', error: 'exceeded maxSteps' })

    // The loop only reports `cancelled` after its signal fired, which is the queue's own abort.
    const exec = agentExecutor(loopReturning('cancelled').loop)
    const controller = new AbortController()
    controller.abort()
    await expect(
      exec(
        { id: 'j', name: 'a', prompt: 'a', status: 'running', enqueuedAt: 0, attempts: 1, maxAttempts: 1 },
        controller.signal,
      ),
    ).rejects.toThrow(/cancelled/)
  })
})

describe('jobQueuePlugin', () => {
  it('mounts ctx.jobQueue once an agent loop and session log exist', async () => {
    const ctx = new Context()
    ctx.plugin(jobQueuePlugin())
    expect(ctx.get('jobQueue')).toBeUndefined()

    const { loop, calls } = (() => {
      const calls: string[] = []
      return {
        calls,
        loop: {
          run: async (input: string): Promise<TaskState> => {
            calls.push(input)
            return { id: 'x', status: 'completed', createdAt: 0, updatedAt: 0 }
          },
        },
      }
    })()
    ctx.set('agentLoop', loop)
    expect(ctx.get('jobQueue')).toBeUndefined()
    ctx.set('sessions', new SessionLog())

    const queue = ctx.get<JobQueue>('jobQueue')!
    await queue.wait(queue.enqueue({ name: 'a', prompt: 'hello' }).id)
    expect(calls).toEqual(['hello'])
  })
})
