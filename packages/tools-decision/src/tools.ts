import type {
  DecisionModel,
  DecisionQuestion,
  DecisionRequest,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistry,
  ToolResult,
} from '@open-agent/agent'
import {
  ArgumentError,
  MAX_CANDIDATES,
  MAX_ITEMS,
  MAX_LEVELS,
  itemsByKey,
  prepareItems,
  requireString,
  round,
} from './items.js'

/**
 * The thresholds that turn a probability into something to act on. Strict on
 * purpose: an `auto` the model trusts blindly has to be right, while a
 * `review` only costs it a look.
 */
const CLASSIFY_AUTO = { probability: 0.85, margin: 0.5 }
const CHECK = { yes: 0.75, no: 0.25 }
const SCORE_AUTO = 0.7
const RELEVANT = 0.5

export interface DecisionToolOptions {
  /** The host the model sends to, from configuration; see `ToolDefinition.fixedDestination`. */
  destination: string
}

type Run = (
  args: Record<string, unknown>,
  decide: (request: DecisionRequest) => ReturnType<DecisionModel['decide']>,
) => Promise<unknown>

/**
 * The shared shell of every decision tool: argument errors and model errors
 * become a failed result the model can read and correct, and a successful
 * one is compact JSON — exact numbers, nothing to parse out of prose.
 */
function decisionTool(
  model: DecisionModel,
  { destination }: DecisionToolOptions,
  definition: { name: string; description: string; schema: Record<string, unknown> },
  run: Run,
): ToolDefinition {
  return {
    ...definition,
    // Reads nothing and changes nothing; it only sends what it is given to
    // the classifier the operator configured.
    permissionLevel: 'safe',
    fixedDestination: destination,
    async execute(args, context: ToolExecutionContext): Promise<ToolResult> {
      try {
        const output = await run(args, (request) => model.decide(request, context.signal))
        return { ok: true, content: JSON.stringify(output) }
      } catch (err) {
        if (context.signal.aborted) throw err
        const prefix = err instanceof ArgumentError ? 'invalid arguments: ' : `${model.name} failed: `
        return { ok: false, content: '', error: prefix + (err instanceof Error ? err.message : String(err)) }
      }
    },
  }
}

const itemsSchema = (description: string, max: number) => ({
  type: 'array',
  maxItems: max,
  description,
  items: {
    type: 'object',
    properties: { id: { type: 'string' }, text: { type: 'string', description: 'The raw text, not a summary of it.' } },
    required: ['id', 'text'],
  },
})

export function classifyItemsTool(model: DecisionModel, options: DecisionToolOptions): ToolDefinition {
  return decisionTool(
    model,
    options,
    {
      name: 'classify_items',
      description:
        'Label many items (issues, log lines, test failures, files, messages) with one of your classes, with a probability each, in one fast call. ' +
        'Use instead of labelling a list by eye. Act on decision "auto"; look at "review" yourself. Include a catch-all class.',
      schema: {
        type: 'object',
        properties: {
          items: itemsSchema(`Up to ${MAX_ITEMS} items.`, MAX_ITEMS),
          classes: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Label to a description of what belongs in it and how it differs from its neighbours.',
          },
          instructions: { type: 'string', description: 'Optional: what the labels are for.' },
        },
        required: ['items', 'classes'],
      },
    },
    async (args, decide) => {
      const items = prepareItems(args.items, 'items', MAX_ITEMS)
      const classes = args.classes as Record<string, unknown>
      if (!classes || typeof classes !== 'object' || Object.keys(classes).length < 2) {
        throw new ArgumentError('classes must map at least two labels to descriptions')
      }
      const options = Object.fromEntries(Object.entries(classes).map(([label, text]) => [label, String(text ?? '')]))
      const purpose =
        typeof args.instructions === 'string' && args.instructions.trim() ? `${args.instructions.trim()} ` : ''
      const questions: Record<string, DecisionQuestion> = {}
      for (const item of items) {
        questions[item.key] = {
          type: 'choice',
          instructions: `${purpose}Which class best describes \`items.${item.key}\`? Judge it on its own.`,
          options,
        }
      }
      const { answers } = await decide({ evidence: { items: itemsByKey(items) }, questions })
      return items.map((item) => {
        const answer = answers[item.key]
        if (answer?.type !== 'choice') return { id: item.id, label: null, decision: 'review' }
        const [top = 0, second = 0] = Object.values(answer.probabilities).sort((a, b) => b - a)
        const probability = answer.probabilities[answer.choice] ?? top
        const margin = top - second
        return {
          id: item.id,
          label: answer.choice,
          probability: round(probability),
          decision: probability >= CLASSIFY_AUTO.probability && margin >= CLASSIFY_AUTO.margin ? 'auto' : 'review',
          ...(item.truncated ? { truncated: true } : {}),
        }
      })
    },
  )
}

export function checkClaimsTool(model: DecisionModel, options: DecisionToolOptions): ToolDefinition {
  return decisionTool(
    model,
    options,
    {
      name: 'check_claims',
      description:
        'Answer yes/no questions about one piece of evidence (a diff, a log, a page) with a calibrated probability each. ' +
        'Use before acting on something unverified, e.g. "do these tests pass?", "does this diff touch auth?". "uncertain" means look closer.',
      schema: {
        type: 'object',
        properties: {
          evidence: { type: 'string', description: 'The raw evidence, not your conclusion about it.' },
          checks: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: `Up to ${MAX_ITEMS} questions, keyed by an id of your choosing.`,
          },
        },
        required: ['evidence', 'checks'],
      },
    },
    async (args, decide) => {
      const evidence = requireString(args.evidence, 'evidence')
      const checks = Object.entries((args.checks ?? {}) as Record<string, unknown>)
      if (checks.length === 0 || checks.length > MAX_ITEMS) {
        throw new ArgumentError(`checks must have between 1 and ${MAX_ITEMS} questions`)
      }
      const questions: Record<string, DecisionQuestion> = {}
      checks.forEach(([, question], index) => {
        questions[`q${index}`] = { type: 'yesno', instructions: requireString(question, 'each check') }
      })
      const { answers } = await decide({ evidence, questions })
      return checks.map(([id], index) => {
        const answer = answers[`q${index}`]
        if (answer?.type !== 'yesno') return { id, verdict: 'uncertain' }
        const verdict = answer.probability >= CHECK.yes ? 'yes' : answer.probability <= CHECK.no ? 'no' : 'uncertain'
        return { id, probability: round(answer.probability), verdict }
      })
    },
  )
}

export function rankCandidatesTool(model: DecisionModel, options: DecisionToolOptions): ToolDefinition {
  return decisionTool(
    model,
    options,
    {
      name: 'rank_candidates',
      description:
        'Rank candidates (files, docs, search results, functions) by how well each answers a question, in one call. ' +
        'Use before opening many of them to pick the few worth reading.',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you are looking for.' },
          candidates: itemsSchema(`Up to ${MAX_CANDIDATES} candidates, each with an excerpt.`, MAX_CANDIDATES),
          top_k: { type: 'integer', minimum: 1, description: 'Return only the best this many.' },
        },
        required: ['query', 'candidates'],
      },
    },
    async (args, decide) => {
      const query = requireString(args.query, 'query')
      const candidates = prepareItems(args.candidates, 'candidates', MAX_CANDIDATES)
      const questions: Record<string, DecisionQuestion> = {
        __any: { type: 'yesno', instructions: 'Does any entry in `candidates` answer or directly help with `query`?' },
      }
      for (const candidate of candidates) {
        questions[candidate.key] = {
          type: 'yesno',
          instructions: `Does \`candidates.${candidate.key}\` answer or directly help with \`query\`? Judge it on its own.`,
          yes: 'It contains what the query asks for, or is the place to look for it',
          no: 'It is about something else, or only shares words with the query',
        }
      }
      const { answers } = await decide({ evidence: { query, candidates: itemsByKey(candidates) }, questions })
      const relevance = (key: string) => {
        const answer = answers[key]
        return answer?.type === 'yesno' ? answer.probability : 0
      }
      const ranked = candidates
        .map((candidate, index) => ({ index, id: candidate.id, relevance: relevance(candidate.key) }))
        .sort((a, b) => b.relevance - a.relevance || a.index - b.index)
      const topK = Number.isInteger(args.top_k) && (args.top_k as number) > 0 ? (args.top_k as number) : ranked.length
      return {
        any_relevant: round(relevance('__any')),
        ranked: ranked.slice(0, topK).map(({ id, relevance }) => ({
          id,
          relevance: round(relevance),
          relevant: relevance >= RELEVANT,
        })),
      }
    },
  )
}

export function scoreItemsTool(model: DecisionModel, options: DecisionToolOptions): ToolDefinition {
  return decisionTool(
    model,
    options,
    {
      name: 'score_items',
      description:
        'Rate many items on one ordered scale (severity, priority, quality, risk) consistently, in one call. ' +
        'Returns the nearest level per item; act on "auto", look at "review" yourself.',
      schema: {
        type: 'object',
        properties: {
          items: itemsSchema(`Up to ${MAX_ITEMS} items.`, MAX_ITEMS),
          levels: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: MAX_LEVELS,
            description: 'What each level means, lowest first.',
          },
          instructions: { type: 'string', description: 'What is being rated, e.g. "How severe is this finding?"' },
        },
        required: ['items', 'levels', 'instructions'],
      },
    },
    async (args, decide) => {
      const items = prepareItems(args.items, 'items', MAX_ITEMS)
      const instructions = requireString(args.instructions, 'instructions')
      const levels = args.levels
      if (!Array.isArray(levels) || levels.length < 2 || levels.length > MAX_LEVELS) {
        throw new ArgumentError(`levels must list between 2 and ${MAX_LEVELS} levels, lowest first`)
      }
      const scale = levels.map((level) => String(level))
      const questions: Record<string, DecisionQuestion> = {}
      for (const item of items) {
        questions[item.key] = {
          type: 'score',
          instructions: `${instructions} Rate \`items.${item.key}\` on its own.`,
          levels: scale,
        }
      }
      const { answers } = await decide({ evidence: { items: itemsByKey(items) }, questions })
      return items.map((item) => {
        const answer = answers[item.key]
        if (answer?.type !== 'score') return { id: item.id, level: null, decision: 'review' }
        const level = Math.min(scale.length - 1, Math.max(0, Math.round(answer.score)))
        return {
          id: item.id,
          level,
          label: scale[level],
          score: round(answer.score),
          decision: answer.confidence >= SCORE_AUTO ? 'auto' : 'review',
        }
      })
    },
  )
}

/** All four, on one model. Returns the function that unregisters them. */
export function mountDecisionTools(
  registry: ToolRegistry,
  model: DecisionModel,
  options: DecisionToolOptions,
): () => void {
  const disposers = [classifyItemsTool, checkClaimsTool, rankCandidatesTool, scoreItemsTool].map((make) =>
    registry.register(make(model, options)),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
}
