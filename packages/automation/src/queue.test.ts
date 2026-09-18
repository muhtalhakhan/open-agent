import { describe, expect, it } from 'vitest'
import { Context } from '@open-agent/context'
import type { TaskState } from '@open-agent/agent'
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
      exec({ id: 'j', name: 'a', prompt: 'a', status: 'running', enqueuedAt: 0 }, controller.signal),
    ).rejects.toThrow(/cancelled/)
  })
})

describe('jobQueuePlugin', () => {
  it('mounts ctx.jobQueue once an agent loop exists', async () => {
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

    const queue = ctx.get<JobQueue>('jobQueue')!
    await queue.wait(queue.enqueue({ name: 'a', prompt: 'hello' }).id)
    expect(calls).toEqual(['hello'])
  })
})
