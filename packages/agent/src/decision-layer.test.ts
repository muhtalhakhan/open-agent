import { describe, expect, it } from 'vitest'
import { AgentLoop } from './agent-loop.js'
import { decideTurn, type DecisionLayerOptions } from './decision-layer.js'
import { SessionLog } from './session.js'
import { ToolRegistry } from './tools.js'
import type { DecisionModel, DecisionRequest, DecisionResponse, LlmAdapter, LlmRequest } from './types.js'

const toolNames = ['read_file', 'write_file', 'run_command', 'web_search', 'http_request', 'list_directory']
const tools = toolNames.map((name) => ({ name, description: `does ${name}` }))

/** Answers each tool question from `relevance` and the route question from `light`. */
function decider(relevance: Record<string, number>, light?: number) {
  const requests: DecisionRequest[] = []
  const model: DecisionModel = {
    name: 'fake',
    async decide(request): Promise<DecisionResponse> {
      requests.push(request)
      const evidence = request.evidence as { tools?: Record<string, string> }
      const answers: DecisionResponse['answers'] = {}
      for (const [key, text] of Object.entries(evidence.tools ?? {})) {
        const name = text.split(':')[0]
        if (name in relevance) answers[key] = { type: 'yesno', probability: relevance[name] }
      }
      if (light !== undefined && 'route' in request.questions) {
        answers.route = {
          type: 'choice',
          choice: light >= 0.5 ? 'light' : 'heavy',
          probabilities: { light, heavy: 1 - light },
          confidence: 1,
        }
      }
      return { answers, usage: { inputTokens: 300, outputTokens: 7 } }
    },
  }
  return { model, requests }
}

const signal = () => new AbortController().signal

describe('decideTurn', () => {
  it('drops only the tools the model is fairly sure are irrelevant, and keeps any it did not answer for', async () => {
    const { model } = decider({
      read_file: 0.9,
      write_file: 0.05,
      run_command: 0.1,
      web_search: 0.3,
      http_request: 0.19,
    })

    const decision = await decideTurn({ model, pruneTools: true }, 'summarize the README', tools, false, signal())

    expect(decision).toEqual({
      llm: 'default',
      tools: ['read_file', 'web_search', 'list_directory'],
      usage: { inputTokens: 300, outputTokens: 7 },
    })
  })

  it('does not spend a call pruning a short tool list', async () => {
    const { model, requests } = decider({})

    const decision = await decideTurn({ model, pruneTools: true }, 'x', tools.slice(0, 3), false, signal())

    expect(decision).toBeUndefined()
    expect(requests).toHaveLength(0)
  })

  it('routes to the light model only when it is sure, and only when there is one', async () => {
    const options: DecisionLayerOptions = { model: decider({}, 0.9).model, routeModel: true }

    expect((await decideTurn(options, 'what is 2+2?', tools, true, signal()))?.llm).toBe('light')
    expect(await decideTurn(options, 'what is 2+2?', tools, false, signal())).toBeUndefined()
    const unsure = { model: decider({}, 0.7).model, routeModel: true }
    expect((await decideTurn(unsure, 'refactor the parser', tools, true, signal()))?.llm).toBe('default')
  })

  it('asks both questions in one call', async () => {
    const { model, requests } = decider({ read_file: 0.9 }, 0.9)

    await decideTurn({ model, pruneTools: true, routeModel: true }, 'x', tools, true, signal())

    expect(requests).toHaveLength(1)
    expect(Object.keys(requests[0].questions)).toContain('route')
    expect(Object.keys(requests[0].questions)).toHaveLength(tools.length + 1)
  })

  it('falls back to all tools and the default model when the decision fails or is too slow', async () => {
    const failing: DecisionModel = {
      name: 'down',
      async decide() {
        throw new Error('503')
      },
    }
    const slow: DecisionModel = {
      name: 'slow',
      decide: (_request, s) =>
        new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(new Error('timed out')))),
    }

    const failed = await decideTurn({ model: failing, pruneTools: true, routeModel: true }, 'x', tools, true, signal())
    const timedOut = await decideTurn({ model: slow, pruneTools: true, timeoutMs: 20 }, 'x', tools, false, signal())

    expect(failed).toEqual({ llm: 'default', error: '503' })
    expect(timedOut).toEqual({ llm: 'default', error: 'timed out' })
  })

  it('lets a cancellation through instead of treating it as a failed decision', async () => {
    const controller = new AbortController()
    const slow: DecisionModel = {
      name: 'slow',
      decide: (_request, s) => new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(s.reason))),
    }
    const pending = decideTurn({ model: slow, pruneTools: true }, 'x', tools, false, controller.signal)
    controller.abort()

    await expect(pending).rejects.toBeDefined()
  })
})

describe('AgentLoop with a decision layer', () => {
  function registry() {
    const registry = new ToolRegistry()
    for (const name of toolNames) {
      registry.register({
        name,
        description: `does ${name}`,
        schema: {},
        permissionLevel: 'safe',
        execute: async () => ({ ok: true, content: '' }),
      })
    }
    return registry
  }

  function recordingLlm(name: string) {
    const requests: LlmRequest[] = []
    const llm: LlmAdapter = {
      name,
      async generate(request) {
        requests.push(request)
        return { message: { role: 'assistant', content: `answered by ${name}` } }
      },
    }
    return { llm, requests }
  }

  it('offers the model only the kept tools, answers with the light model, and logs that first', async () => {
    const sessions = new SessionLog()
    const main = recordingLlm('main')
    const light = recordingLlm('light')
    const { model } = decider({ read_file: 0.9, write_file: 0, run_command: 0, web_search: 0, http_request: 0 }, 0.95)
    const loop = new AgentLoop({
      sessions,
      tools: registry(),
      llm: main.llm,
      lightLlm: light.llm,
      decisions: { model, pruneTools: true, routeModel: true },
    })

    const task = await loop.run('read the README', signal(), 't1')

    expect(task.status).toBe('completed')
    expect(main.requests).toHaveLength(0)
    expect(light.requests[0].tools.map((tool) => tool.name)).toEqual(['read_file', 'list_directory'])
    const types = sessions.all('t1').map((event) => event.type)
    expect(types.indexOf('turn/decision')).toBeLessThan(types.indexOf('assistant/message'))
    expect(sessions.all('t1').find((event) => event.type === 'turn/decision')).toMatchObject({
      tools: ['read_file', 'list_directory'],
      llm: 'light',
      usage: { inputTokens: 300, outputTokens: 7 },
    })
  })

  it('runs the turn exactly as without it when the decision fails', async () => {
    const sessions = new SessionLog()
    const main = recordingLlm('main')
    const loop = new AgentLoop({
      sessions,
      tools: registry(),
      llm: main.llm,
      lightLlm: recordingLlm('light').llm,
      decisions: {
        model: {
          name: 'down',
          async decide() {
            throw new Error('503')
          },
        },
        pruneTools: true,
        routeModel: true,
      },
    })

    const task = await loop.run('anything', signal(), 't1')

    expect(task.status).toBe('completed')
    expect(main.requests[0].tools).toHaveLength(toolNames.length)
    expect(sessions.all('t1').find((event) => event.type === 'turn/decision')).toMatchObject({
      llm: 'default',
      error: '503',
    })
  })
})
