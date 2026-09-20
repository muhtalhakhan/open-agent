import { describe, expect, it } from 'vitest'
import { createTerminalTakeoverHandler, describeRequest } from './takeover.js'
import type { TakeoverRequest } from '@open-agent/agent'

const login: TakeoverRequest = {
  taskId: 't1',
  kind: 'login',
  reason: 'the archive is behind a sign-in',
  target: 'example.test',
}
const takeover: TakeoverRequest = { taskId: 't1', kind: 'takeover', reason: 'this needs your decision' }

/** Answers each question in turn, recording what was asked. */
function answering(...replies: string[]) {
  const asked: string[] = []
  let index = 0
  return {
    asked,
    ask: async (question: string) => {
      asked.push(question)
      return replies[index++] ?? ''
    },
  }
}

const live = () => new AbortController().signal

describe('describeRequest', () => {
  it('names the site, so it is read before a sign-in form is', () => {
    expect(describeRequest(login)).toContain('example.test')
    expect(describeRequest(login)).toContain('the archive is behind a sign-in')
  })

  it('tells the person not to type a password at the agent', () => {
    expect(describeRequest(login)).toMatch(/do not type any password here/i)
  })

  it('says the agent will wait, for a plain takeover', () => {
    expect(describeRequest(takeover)).toMatch(/will not act until you hand control back/i)
  })
})

describe('createTerminalTakeoverHandler', () => {
  it('asks first, then waits for the person to finish', async () => {
    const { ask, asked } = answering('y', '')
    const outcome = await createTerminalTakeoverHandler(ask)(login, () => {}, live())

    expect(asked).toHaveLength(2)
    expect(asked[0]).toContain('Hand over now?')
    expect(asked[1]).toContain('Press Enter when you are done')
    expect(outcome).toBe('completed')
  })

  it('declines without waiting when the person says no', async () => {
    const { ask, asked } = answering('n')
    const outcome = await createTerminalTakeoverHandler(ask)(login, () => {}, live())

    expect(asked).toHaveLength(1)
    expect(outcome).toBe('declined')
  })

  it('treats an empty answer to the first question as no', async () => {
    const { ask } = answering('', '')
    expect(await createTerminalTakeoverHandler(ask)(login, () => {}, live())).toBe('declined')
  })

  it('grants the lease only once the person has accepted', async () => {
    const granted: string[] = []
    const { ask } = answering('y', '')
    await createTerminalTakeoverHandler(ask)(login, () => granted.push('granted'), live())
    expect(granted).toEqual(['granted'])

    granted.length = 0
    const declining = answering('n')
    await createTerminalTakeoverHandler(declining.ask)(login, () => granted.push('granted'), live())
    expect(granted).toEqual([])
  })

  it('lets the person back out part-way through', async () => {
    const { ask } = answering('y', 'cancel')
    expect(await createTerminalTakeoverHandler(ask)(login, () => {}, live())).toBe('declined')
  })

  it('asks nothing at all once the task has been cancelled', async () => {
    const { ask, asked } = answering('y', '')
    const controller = new AbortController()
    controller.abort()

    expect(await createTerminalTakeoverHandler(ask)(login, () => {}, controller.signal)).toBe('cancelled')
    expect(asked).toEqual([])
  })

  it('reports a cancellation that arrives while the person is driving', async () => {
    const controller = new AbortController()
    const ask = async (question: string) => {
      if (question.includes('Press Enter')) controller.abort()
      return ''
    }

    const outcome = await createTerminalTakeoverHandler(async (q) => {
      const answer = await ask(q)
      return q.includes('Hand over') ? 'y' : answer
    })(login, () => {}, controller.signal)

    expect(outcome).toBe('cancelled')
  })
})
