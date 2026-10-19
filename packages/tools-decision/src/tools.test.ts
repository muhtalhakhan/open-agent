import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '@open-agent/agent'
import type { DecisionModel, DecisionRequest, DecisionResponse, ToolDefinition } from '@open-agent/agent'
import { checkClaimsTool, classifyItemsTool, mountDecisionTools, rankCandidatesTool, scoreItemsTool } from './tools.js'

/** Answers from a script and keeps every request, so tests can see what was asked. */
function scripted(answer: (request: DecisionRequest) => DecisionResponse['answers']) {
  const requests: DecisionRequest[] = []
  const model: DecisionModel = {
    name: 'scripted',
    async decide(request) {
      requests.push(request)
      return { answers: answer(request) }
    },
  }
  return { model, requests }
}

const options = { destination: 'api.decide.test' }
const context = () => ({ taskId: 't1', signal: new AbortController().signal })

async function run(tool: ToolDefinition, args: Record<string, unknown>) {
  const result = await tool.execute(args, context())
  return { ...result, output: result.ok ? JSON.parse(result.content) : undefined }
}

describe('classify_items', () => {
  it('asks one choice question per item and acts only on a clear winner', async () => {
    const { model, requests } = scripted(() => ({
      a: { type: 'choice', choice: 'bug', probabilities: { bug: 0.95, flaky: 0.05 }, confidence: 0.9 },
      b: { type: 'choice', choice: 'flaky', probabilities: { bug: 0.4, flaky: 0.6 }, confidence: 0.3 },
    }))

    const { output } = await run(classifyItemsTool(model, options), {
      items: [
        { id: 'a', text: 'TypeError: x is undefined' },
        { id: 'b', text: 'ETIMEDOUT' },
        { id: 'c', text: 'no answer for this one' },
      ],
      classes: { bug: 'The code is wrong', flaky: 'Passes on retry' },
    })

    expect(requests[0].evidence).toEqual({
      items: { a: 'TypeError: x is undefined', b: 'ETIMEDOUT', c: 'no answer for this one' },
    })
    expect(requests[0].questions.a).toMatchObject({ type: 'choice', options: { bug: 'The code is wrong' } })
    expect(output).toEqual([
      { id: 'a', label: 'bug', probability: 0.95, decision: 'auto' },
      { id: 'b', label: 'flaky', probability: 0.6, decision: 'review' },
      { id: 'c', label: null, decision: 'review' },
    ])
  })

  it('gives ids that would read as paths a safe key, and echoes the original back', async () => {
    const { model, requests } = scripted((request) => ({
      [Object.keys(request.questions)[0]]: {
        type: 'choice',
        choice: 'x',
        probabilities: { x: 1, y: 0 },
        confidence: 1,
      },
    }))

    const { output } = await run(classifyItemsTool(model, options), {
      items: [{ id: 'src/a.ts', text: '...' }],
      classes: { x: '', y: '' },
    })

    expect(Object.keys(requests[0].questions)).toEqual(['src_a_ts'])
    expect(output[0].id).toBe('src/a.ts')
  })

  it('refuses bad arguments without calling the model, saying what to fix', async () => {
    const { model, requests } = scripted(() => ({}))
    const tool = classifyItemsTool(model, options)

    const noClasses = await run(tool, { items: [{ id: 'a', text: 'x' }], classes: { only: 'one' } })
    const clash = await run(tool, {
      items: [
        { id: 'a b', text: 'x' },
        { id: 'a_b', text: 'y' },
      ],
      classes: { x: '', y: '' },
    })
    const tooMany = await run(tool, {
      items: Array.from({ length: 65 }, (_, i) => ({ id: String(i), text: 'x' })),
      classes: { x: '', y: '' },
    })

    expect(noClasses.error).toContain('at least two labels')
    expect(clash.error).toContain('not distinct')
    expect(tooMany.error).toContain('at most 64')
    expect(requests).toHaveLength(0)
  })

  it('cuts very long items, and says it did', async () => {
    const { model, requests } = scripted(() => ({
      a: { type: 'choice', choice: 'x', probabilities: { x: 1, y: 0 }, confidence: 1 },
    }))

    const { output } = await run(classifyItemsTool(model, options), {
      items: [{ id: 'a', text: 'x'.repeat(10_000) }],
      classes: { x: '', y: '' },
    })

    expect((requests[0].evidence as { items: Record<string, string> }).items.a.length).toBeLessThan(4_100)
    expect(output[0].truncated).toBe(true)
  })
})

describe('check_claims', () => {
  it('turns each probability into yes, no or uncertain', async () => {
    const { model, requests } = scripted(() => ({
      q0: { type: 'yesno', probability: 0.9 },
      q1: { type: 'yesno', probability: 0.1 },
      q2: { type: 'yesno', probability: 0.5 },
    }))

    const { output } = await run(checkClaimsTool(model, options), {
      evidence: '12 passed, 0 failed',
      checks: {
        pass: 'Did all tests pass?',
        fail: 'Did any test fail?',
        slow: 'Was the run slow?',
        none: 'Unanswered?',
      },
    })

    expect(requests[0].evidence).toBe('12 passed, 0 failed')
    expect(output).toEqual([
      { id: 'pass', probability: 0.9, verdict: 'yes' },
      { id: 'fail', probability: 0.1, verdict: 'no' },
      { id: 'slow', probability: 0.5, verdict: 'uncertain' },
      { id: 'none', verdict: 'uncertain' },
    ])
  })
})

describe('rank_candidates', () => {
  it('sorts by relevance, keeps ties in the given order, and cuts to top_k', async () => {
    const { model } = scripted(() => ({
      __any: { type: 'yesno', probability: 0.97 },
      a: { type: 'yesno', probability: 0.2 },
      b: { type: 'yesno', probability: 0.9 },
      c: { type: 'yesno', probability: 0.9 },
    }))

    const { output } = await run(rankCandidatesTool(model, options), {
      query: 'where is the config parsed?',
      candidates: [
        { id: 'a', text: 'README' },
        { id: 'b', text: 'config.ts' },
        { id: 'c', text: 'args.ts' },
      ],
      top_k: 2,
    })

    expect(output).toEqual({
      any_relevant: 0.97,
      ranked: [
        { id: 'b', relevance: 0.9, relevant: true },
        { id: 'c', relevance: 0.9, relevant: true },
      ],
    })
  })
})

describe('score_items', () => {
  it('reports the nearest level and its label', async () => {
    const { model, requests } = scripted(() => ({
      a: { type: 'score', score: 1.7, confidence: 0.8 },
      b: { type: 'score', score: 0.2, confidence: 0.4 },
    }))

    const { output } = await run(scoreItemsTool(model, options), {
      items: [
        { id: 'a', text: 'SQL injection in login' },
        { id: 'b', text: 'typo in a comment' },
      ],
      levels: ['low', 'medium', 'high'],
      instructions: 'How severe is this finding?',
    })

    expect(requests[0].questions.a).toMatchObject({ type: 'score', levels: ['low', 'medium', 'high'] })
    expect(output).toEqual([
      { id: 'a', level: 2, label: 'high', score: 1.7, decision: 'auto' },
      { id: 'b', level: 0, label: 'low', score: 0.2, decision: 'review' },
    ])
  })
})

describe('mountDecisionTools', () => {
  it('registers all four as safe tools bound to the configured destination, and takes them away again', () => {
    const registry = new ToolRegistry()
    const { model } = scripted(() => ({}))

    const dispose = mountDecisionTools(registry, model, options)
    const mounted = registry.list()

    expect(mounted.map((tool) => tool.name).sort()).toEqual([
      'check_claims',
      'classify_items',
      'rank_candidates',
      'score_items',
    ])
    expect(
      mounted.every((tool) => tool.permissionLevel === 'safe' && tool.fixedDestination === 'api.decide.test'),
    ).toBe(true)
    dispose()
    expect(registry.list()).toHaveLength(0)
  })

  it('reports a model failure as a failed result the agent can read', async () => {
    const model: DecisionModel = {
      name: 'jev',
      async decide() {
        throw new Error('503 Service Unavailable')
      },
    }

    const result = await checkClaimsTool(model, options).execute({ evidence: 'x', checks: { a: 'y?' } }, context())

    expect(result).toEqual({ ok: false, content: '', error: 'jev failed: 503 Service Unavailable' })
  })
})
