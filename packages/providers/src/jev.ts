import type {
  DecisionAnswer,
  DecisionModel,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
  TokenUsage,
} from '@open-agent/agent'
import { ProviderHttpError } from './errors.js'

export interface JevOptions {
  apiKey: string
  /** Defaults to https://api.typesafe.ai */
  baseURL?: string
  /** Defaults to `jev-latest`. */
  model?: string
  /** Per attempt. A decision that takes longer has stopped saving anything. */
  timeoutMs?: number
  /** Retries after a rate limit or a transient failure; 2 unless set. */
  maxRetries?: number
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch
  /** Injectable for tests, so a retry does not wait for real. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Jev's context is about 32K tokens. Refused here, before a request is paid
 * for, rather than by the API after it.
 */
const MAX_REQUEST_CHARS = 120_000
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 529])
const MAX_RETRY_AFTER_MS = 30_000

type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] }

type JevAnswer =
  | { type: 'noul'; noul?: unknown }
  | { type: 'choice'; choice?: unknown; probabilities?: unknown; confidence?: unknown }
  | { type: 'score'; score?: unknown; confidence?: unknown }

function toJevQuestion(question: DecisionQuestion): JevQuestion {
  switch (question.type) {
    case 'yesno': {
      const criteria = {
        ...(question.yes !== undefined ? { true: question.yes } : {}),
        ...(question.no !== undefined ? { false: question.no } : {}),
      }
      return Object.keys(criteria).length
        ? { type: 'noul', instructions: question.instructions, criteria }
        : { type: 'noul', instructions: question.instructions }
    }
    case 'choice':
      return { type: 'choice', instructions: question.instructions, criteria: question.options }
    case 'score':
      return { type: 'score', instructions: question.instructions, criteria: question.levels }
  }
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * The API's answer for one question, if it is the shape that question asked
 * for. Anything else is dropped rather than guessed at: a caller acting on a
 * decision should see "no answer", never a default dressed up as one.
 */
function fromJevAnswer(question: DecisionQuestion, answer: JevAnswer | undefined): DecisionAnswer | undefined {
  if (!answer) return undefined
  if (question.type === 'yesno' && answer.type === 'noul' && isNumber(answer.noul)) {
    return { type: 'yesno', probability: answer.noul }
  }
  if (question.type === 'choice' && answer.type === 'choice' && typeof answer.choice === 'string') {
    const probabilities = (answer.probabilities ?? {}) as Record<string, unknown>
    const clean = Object.fromEntries(Object.entries(probabilities).filter(([, p]) => isNumber(p))) as Record<
      string,
      number
    >
    if (!(answer.choice in question.options)) return undefined
    return {
      type: 'choice',
      choice: answer.choice,
      probabilities: clean,
      confidence: isNumber(answer.confidence) ? answer.confidence : 0,
    }
  }
  if (question.type === 'score' && answer.type === 'score' && isNumber(answer.score)) {
    return { type: 'score', score: answer.score, confidence: isNumber(answer.confidence) ? answer.confidence : 0 }
  }
  return undefined
}

function retryAfterMs(headers: Headers): number | undefined {
  const ms = Number(headers.get('retry-after-ms') ?? NaN)
  if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, MAX_RETRY_AFTER_MS)
  const seconds = Number(headers.get('retry-after') ?? NaN)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  return undefined
}

/**
 * Jev, TypeSafe's System One classifier, behind the `DecisionModel` seam:
 * `POST /v1/systemone` with the evidence as `state` and typed questions,
 * answered with calibrated probabilities in a few hundred milliseconds.
 *
 * A request goes to TypeSafe with whatever evidence the caller put in it —
 * task content, tool output. That is the point of it, and why the CLI only
 * builds one when a key is configured.
 */
export class JevDecisionModel implements DecisionModel {
  readonly name = 'jev'
  private readonly baseURL: string
  private readonly model: string

  constructor(private readonly options: JevOptions) {
    this.baseURL = (options.baseURL ?? 'https://api.typesafe.ai').replace(/\/+$/, '')
    this.model = options.model ?? 'jev-latest'
  }

  async decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResponse> {
    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [id, toJevQuestion(question)]),
    )
    const body = JSON.stringify({ model: this.model, state: request.evidence, questions })
    if (body.length > MAX_REQUEST_CHARS) {
      throw new Error(
        `jev: request is ${body.length} characters, over the ${MAX_REQUEST_CHARS} Jev accepts. Send fewer or shorter items.`,
      )
    }

    const url = `${this.baseURL}/v1/systemone`
    const fetchFn = this.options.fetchFn ?? fetch
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
    const maxRetries = this.options.maxRetries ?? 2
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs ?? 30_000)]),
      })
      if (response.ok) return this.parse(request, (await response.json()) as unknown)

      const text = await response.text()
      if (attempt >= maxRetries || !RETRYABLE.has(response.status)) {
        throw new ProviderHttpError(response.status, this.name, url, text)
      }
      await sleep(retryAfterMs(response.headers) ?? Math.min(8_000, 500 * 2 ** attempt))
    }
  }

  private parse(request: DecisionRequest, data: unknown): DecisionResponse {
    const payload = (data ?? {}) as { answers?: Record<string, JevAnswer>; usage?: Record<string, unknown> }
    if (!payload.answers || typeof payload.answers !== 'object') throw new Error('jev: response has no answers')
    const answers: Record<string, DecisionAnswer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = fromJevAnswer(question, payload.answers[id])
      if (answer) answers[id] = answer
    }
    const { input_tokens, output_tokens } = payload.usage ?? {}
    const usage: TokenUsage | undefined =
      isNumber(input_tokens) && isNumber(output_tokens)
        ? { inputTokens: input_tokens, outputTokens: output_tokens }
        : undefined
    return usage ? { answers, usage } : { answers }
  }
}
