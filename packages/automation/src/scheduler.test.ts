import { describe, expect, it, vi } from 'vitest'
import { Scheduler } from './scheduler.js'
import { MemoryTaskStore } from './store.js'
import type { TaskDispatch, TaskRunner, TriggerEvaluator } from './types.js'

/**
 * A hand-driven clock plus timer pair. Nothing in these tests waits on real
 * time: `advance()` moves the clock and fires any timer that came due.
 */
function fakeClock(start = 1_000) {
  let now = start
  let pending: { fn: () => void; at: number } | undefined
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      pending = { fn, at: now + ms }
      return pending
    },
    clearTimer: () => {
      pending = undefined
    },
    /** Moves time forward and runs the armed timer if it is now due. */
    async advance(ms: number) {
      now += ms
      for (let i = 0; i < 100 && pending && pending.at <= now; i++) {
        const due = pending
        pending = undefined
        due.fn()
        await Promise.resolve()
        await Promise.resolve()
      }
    },
    get armed() {
      return pending?.at
    },
  }
}

function recordingRunner(): TaskRunner & { calls: TaskDispatch[] } {
  const calls: TaskDispatch[] = []
  const runner = Object.assign(
    async (dispatch: TaskDispatch) => {
      calls.push(dispatch)
    },
    { calls },
  )
  return runner
}

/** Fires every `everyMs`, forever — stands in for the recurring triggers of #78. */
const everyTrigger: TriggerEvaluator = (spec, from) => from + (spec.everyMs as number)

describe('Scheduler', () => {
  it('fires an "at" task once, when it comes due', async () => {
    const clock = fakeClock()
    const runner = recordingRunner()
    const scheduler = new Scheduler({ runner, ...clock })

    await scheduler.start()
    const task = await scheduler.add({ name: 'report', prompt: 'write the report', trigger: { kind: 'at', at: 5_000 } })
    expect(runner.calls).toHaveLength(0)
    expect(scheduler.get(task.id)?.status).toBe('pending')

    await clock.advance(4_000)
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0].task.id).toBe(task.id)

    // It never fires a second time, however far the clock runs.
    await clock.advance(100_000)
    expect(runner.calls).toHaveLength(1)
    const after = scheduler.get(task.id)!
    expect(after.status).toBe('done')
    expect(after.runCount).toBe(1)
    expect(after.nextRunAt).toBeUndefined()
  })

  it('re-arms a recurring trigger from the fire time, not from when the run finished', async () => {
    const clock = fakeClock()
    let finishRun: (() => void) | undefined
    const runner = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          finishRun = resolve
        }),
    )
    const scheduler = new Scheduler({
      runner,
      triggers: { every: everyTrigger },
      ...clock,
    })

    await scheduler.start()
    const task = await scheduler.add({
      name: 'hourly',
      prompt: 'check inbox',
      trigger: { kind: 'every', everyMs: 1_000, at: 0 },
    })

    await clock.advance(1_000) // fires at t=2000
    expect(runner).toHaveBeenCalledTimes(1)

    // The run drags on well past the next occurrence before finishing.
    await clock.advance(5_000)
    finishRun!()
    await Promise.resolve()
    await Promise.resolve()

    // Next fire is fire-time + interval (3000), not finish-time + interval.
    expect(scheduler.get(task.id)?.nextRunAt).toBe(3_000)
  })

  it('runs a task whose fire time passed while the process was down', async () => {
    const store = new MemoryTaskStore()
    await store.save([
      {
        id: 'missed',
        name: 'backup',
        prompt: 'back up the workspace',
        trigger: { kind: 'at', at: 500 },
        status: 'pending',
        createdAt: 0,
        nextRunAt: 500,
        runCount: 0,
      },
    ])

    const clock = fakeClock(10_000)
    const runner = recordingRunner()
    const scheduler = new Scheduler({ runner, store, ...clock })

    await scheduler.start()
    expect(runner.calls).toHaveLength(1)
    expect(scheduler.get('missed')?.status).toBe('done')
  })

  it('puts a task left mid-run by a crash back in line instead of stranding it', async () => {
    const store = new MemoryTaskStore()
    await store.save([
      {
        id: 'interrupted',
        name: 'sync',
        prompt: 'sync',
        trigger: { kind: 'at', at: 500 },
        status: 'running',
        createdAt: 0,
        nextRunAt: 500,
        runCount: 0,
      },
    ])

    const clock = fakeClock(10_000)
    const runner = recordingRunner()
    const scheduler = new Scheduler({ runner, store, ...clock })

    await scheduler.start()
    expect(runner.calls).toHaveLength(1)
  })

  it('records a failed run and keeps a recurring task scheduled', async () => {
    const clock = fakeClock()
    const runner = vi.fn(async () => {
      throw new Error('provider unreachable')
    })
    const scheduler = new Scheduler({ runner, triggers: { every: everyTrigger }, ...clock })

    await scheduler.start()
    const task = await scheduler.add({ name: 'poll', prompt: 'poll', trigger: { kind: 'every', everyMs: 1_000 } })

    await clock.advance(1_000)
    const after = scheduler.get(task.id)!
    expect(after.lastError).toBe('provider unreachable')
    expect(after.runCount).toBe(1)
    expect(after.status).toBe('pending')
    expect(after.nextRunAt).toBe(3_000)
  })

  it('marks a one-time task failed when its only run throws', async () => {
    const clock = fakeClock()
    const scheduler = new Scheduler({
      runner: async () => {
        throw new Error('nope')
      },
      ...clock,
    })

    await scheduler.start()
    const task = await scheduler.add({ name: 'once', prompt: 'once', trigger: { kind: 'at', at: 2_000 } })
    await clock.advance(1_000)

    expect(scheduler.get(task.id)?.status).toBe('failed')
    expect(scheduler.get(task.id)?.lastError).toBe('nope')
  })

  it('does not start a second run while the first is still in flight', async () => {
    const clock = fakeClock()
    let running = 0
    let peak = 0
    let finishRun: (() => void) | undefined
    const scheduler = new Scheduler({
      runner: async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise<void>((resolve) => {
          finishRun = () => {
            running--
            resolve()
          }
        })
      },
      triggers: { every: everyTrigger },
      ...clock,
    })

    await scheduler.start()
    await scheduler.add({ name: 'tight', prompt: 'tight', trigger: { kind: 'every', everyMs: 100 } })

    await clock.advance(100)
    await scheduler.tick()
    await scheduler.tick()
    expect(peak).toBe(1)

    finishRun!()
  })

  it('skips paused tasks and recomputes the fire time on resume', async () => {
    const clock = fakeClock()
    const runner = recordingRunner()
    const scheduler = new Scheduler({ runner, triggers: { every: everyTrigger }, ...clock })

    await scheduler.start()
    const task = await scheduler.add({ name: 'digest', prompt: 'digest', trigger: { kind: 'every', everyMs: 1_000 } })

    await scheduler.pause(task.id)
    await clock.advance(10_000)
    expect(runner.calls).toHaveLength(0)
    expect(scheduler.get(task.id)?.status).toBe('paused')

    // Resuming schedules from now (11_000), not from the occurrences slept through.
    await scheduler.resume(task.id)
    expect(scheduler.get(task.id)?.nextRunAt).toBe(12_000)
    expect(runner.calls).toHaveLength(0)
  })

  it('cancels a task so it never fires again', async () => {
    const clock = fakeClock()
    const runner = recordingRunner()
    const scheduler = new Scheduler({ runner, ...clock })

    await scheduler.start()
    const task = await scheduler.add({ name: 'gone', prompt: 'gone', trigger: { kind: 'at', at: 2_000 } })
    await scheduler.cancel(task.id)

    await clock.advance(10_000)
    expect(runner.calls).toHaveLength(0)
    expect(scheduler.get(task.id)?.status).toBe('cancelled')
  })

  it('rejects an unknown trigger kind at add() rather than at fire time', async () => {
    const scheduler = new Scheduler({ runner: async () => {}, ...fakeClock() })
    await expect(
      scheduler.add({ name: 'x', prompt: 'x', trigger: { kind: 'cron', expr: '* * * * *' } }),
    ).rejects.toThrow(/unknown trigger kind "cron"/)
  })

  it('lists the schedule soonest first, with never-firing entries last', async () => {
    const clock = fakeClock()
    const scheduler = new Scheduler({ runner: async () => {}, ...clock })

    await scheduler.add({ id: 'late', name: 'late', prompt: 'p', trigger: { kind: 'at', at: 9_000 } })
    await scheduler.add({ id: 'soon', name: 'soon', prompt: 'p', trigger: { kind: 'at', at: 2_000 } })
    await scheduler.add({ id: 'never', name: 'never', prompt: 'p', trigger: { kind: 'at', at: 5_000 } })
    await scheduler.cancel('never')

    expect(scheduler.list().map((t) => t.id)).toEqual(['soon', 'late', 'never'])
    expect(scheduler.list({ status: 'pending' }).map((t) => t.id)).toEqual(['soon', 'late'])
  })

  it('lets a plugin contribute a trigger kind and take it away again', async () => {
    const scheduler = new Scheduler({ runner: async () => {}, ...fakeClock() })
    const remove = scheduler.registerTrigger('every', everyTrigger)

    const task = await scheduler.add({ name: 'r', prompt: 'p', trigger: { kind: 'every', everyMs: 500 } })
    expect(scheduler.get(task.id)?.nextRunAt).toBe(1_500)

    remove()
    await expect(scheduler.add({ name: 'r2', prompt: 'p', trigger: { kind: 'every', everyMs: 500 } })).rejects.toThrow(
      /unknown trigger kind/,
    )
  })

  it('arms one timer for the soonest task and stops firing after stop()', async () => {
    const clock = fakeClock()
    const runner = recordingRunner()
    const scheduler = new Scheduler({ runner, ...clock })

    await scheduler.start()
    await scheduler.add({ name: 'a', prompt: 'p', trigger: { kind: 'at', at: 8_000 } })
    await scheduler.add({ name: 'b', prompt: 'p', trigger: { kind: 'at', at: 3_000 } })
    expect(clock.armed).toBe(3_000)

    await scheduler.stop()
    expect(clock.armed).toBeUndefined()
    await clock.advance(100_000)
    expect(runner.calls).toHaveLength(0)
  })

  it('survives a task scheduled beyond the 32-bit timer limit', async () => {
    const clock = fakeClock()
    const runner = recordingRunner()
    const scheduler = new Scheduler({ runner, ...clock })

    await scheduler.start()
    // Roughly a year out — far past setTimeout's signed-32-bit ceiling.
    await scheduler.add({ name: 'annual', prompt: 'p', trigger: { kind: 'at', at: 32_000_000_000 } })

    // The timer is clamped rather than overflowing into firing immediately.
    expect(clock.armed).toBe(1_000 + 2_147_483_647)
    await clock.advance(2_147_483_647)
    expect(runner.calls).toHaveLength(0)
    expect(scheduler.get(scheduler.list()[0].id)?.status).toBe('pending')
  })
})
