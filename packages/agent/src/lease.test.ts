import { describe, expect, it, vi } from 'vitest'
import { LeaseManager, describeOutcome } from './lease.js'
import { SessionLog } from './session.js'
import type { TakeoverHandler, TakeoverRequest } from './index.js'

const request = (over: Partial<TakeoverRequest> = {}): TakeoverRequest => ({
  taskId: 't1',
  kind: 'login',
  reason: 'the site wants a sign-in',
  target: 'example.test',
  ...over,
})

const live = () => new AbortController().signal

function setup(handler: TakeoverHandler, isUnattended?: (taskId: string) => boolean) {
  const sessions = new SessionLog()
  return { sessions, leases: new LeaseManager({ sessions, handler, isUnattended }) }
}

/** The lease events a task recorded, in order. */
const leaseEvents = (sessions: SessionLog, taskId = 't1') =>
  sessions.all(taskId).filter((e) => e.type.startsWith('lease/'))

describe('LeaseManager', () => {
  it('reports the agent as driving until something hands over', async () => {
    const { leases } = setup(async () => 'completed')
    expect(leases.state('t1')).toEqual({ holder: 'agent' })
  })

  it('runs the handoff and returns what the person decided', async () => {
    const { leases } = setup(async () => 'completed')
    expect(await leases.handOver(request(), live())).toBe('completed')
  })

  it('records the request and the return in the session log', async () => {
    const { sessions, leases } = setup(async () => 'completed')

    await leases.handOver(request(), live())

    expect(leaseEvents(sessions).map((e) => e.type)).toEqual(['lease/requested', 'lease/returned'])
    const [asked, returned] = leaseEvents(sessions)
    expect(asked).toMatchObject({ kind: 'login', target: 'example.test', reason: 'the site wants a sign-in' })
    expect(returned).toMatchObject({ outcome: 'completed' })
  })

  it('says a person is driving only once they have accepted', async () => {
    const seen: string[] = []
    const { leases } = setup(async (req, grant) => {
      seen.push(leases.state(req.taskId).holder)
      grant()
      seen.push(leases.state(req.taskId).holder)
      return 'completed'
    })

    await leases.handOver(request(), live())

    expect(seen).toEqual(['pending', 'human'])
    // And the agent has it back afterwards.
    expect(leases.state('t1')).toEqual({ holder: 'agent' })
  })

  it('refuses a second handoff while one is open', async () => {
    let release: (() => void) | undefined
    const { leases } = setup(async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return 'completed'
    })

    const first = leases.handOver(request(), live())
    await vi.waitFor(() => expect(leases.state('t1').holder).toBe('pending'))
    expect(await leases.handOver(request({ kind: 'takeover' }), live())).toBe('busy')

    release?.()
    expect(await first).toBe('completed')
  })

  it('refuses rather than waits when nobody is watching the task', async () => {
    const handler = vi.fn<TakeoverHandler>(async () => 'completed')
    const { leases } = setup(handler, (taskId) => taskId === 't1')

    // A background job would otherwise wait on a person who never arrives.
    expect(await leases.handOver(request(), live())).toBe('unavailable')
    expect(handler).not.toHaveBeenCalled()
  })

  it('reports a cancelled task without troubling anyone', async () => {
    const handler = vi.fn<TakeoverHandler>(async () => 'completed')
    const { leases } = setup(handler)
    const controller = new AbortController()
    controller.abort()

    expect(await leases.handOver(request(), controller.signal)).toBe('cancelled')
    expect(handler).not.toHaveBeenCalled()
  })

  it('frees the lease when the handler throws, so later handoffs still work', async () => {
    let fail = true
    const { leases } = setup(async () => {
      if (fail) throw new Error('the terminal went away')
      return 'completed'
    })

    expect(await leases.handOver(request(), live())).toBe('failed')
    expect(leases.state('t1')).toEqual({ holder: 'agent' })

    fail = false
    expect(await leases.handOver(request(), live())).toBe('completed')
  })

  it('keeps one task’s handoff out of another’s way', async () => {
    let release: (() => void) | undefined
    const { leases } = setup(async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return 'completed'
    })

    void leases.handOver(request({ taskId: 't1' }), live())
    await vi.waitFor(() => expect(leases.state('t1').holder).toBe('pending'))

    expect(leases.state('t2')).toEqual({ holder: 'agent' })
    release?.()
  })
})

describe('describeOutcome', () => {
  it('tells the model a person dealt with it, and not to ask for credentials', () => {
    const told = describeOutcome('completed', request())
    expect(told).toContain('example.test')
    expect(told).toMatch(/do not ask for any credentials/i)
  })

  it('has something to say for every outcome', () => {
    const outcomes = ['completed', 'declined', 'cancelled', 'unavailable', 'busy', 'failed'] as const
    for (const outcome of outcomes) {
      expect(describeOutcome(outcome, request())).toBeTruthy()
    }
  })
})
