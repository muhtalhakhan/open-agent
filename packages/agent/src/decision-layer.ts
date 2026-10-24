import type { DecisionModel, DecisionQuestion, TokenUsage, ToolDefinition } from './types.js'

export interface DecisionLayerOptions {
  model: DecisionModel
  /** Send the model only the tools this task could use, instead of every schema on every step. */
  pruneTools?: boolean
  /** Hand tasks judged light to `AgentLoopOptions.lightLlm`. Needs one configured. */
  routeModel?: boolean
  /**
   * Below this many tools pruning is skipped: the schemas it would save cost
   * less than the call that decides which to drop. Default 6.
   */
  minToolsToPrune?: number
  /**
   * A tool is kept unless the model is fairly sure it is irrelevant. Low on
   * purpose: dropping a tool the task needs costs a failed task, keeping one
   * it doesn't costs a few hundred tokens. Default 0.2.
   */
  keepToolAt?: number
  /** How sure the model must be that a task is light before it gets the cheaper model. Default 0.8. */
  routeLightAt?: number
  /** A decision slower than this has stopped paying for itself; the turn goes ahead undecided. Default 3000. */
  timeoutMs?: number
}

/** What was decided for one turn, as recorded in the session log. */
export interface TurnDecision {
  /** Tools offered to the model this turn; absent means all of them. */
  tools?: string[]
  llm: 'default' | 'light'
  /** What the decision itself cost. */
  usage?: TokenUsage
  /** Why it fell back to doing nothing, when it did. */
  error?: string
}

const TOOL_KEY = (index: number) => `tool_${index}`
const ROUTE_KEY = 'route'

/**
 * Decides, once per turn and before any LLM request, two things that make
 * the turn cheaper: which tool schemas to leave out, and whether the cheaper
 * model will do. One decision-model call answers both.
 *
 * Every failure is the same as no decision: all tools, the default model.
 * Nothing here can make a turn fail that would have succeeded without it.
 */
export async function decideTurn(
  options: DecisionLayerOptions,
  task: string,
  tools: Pick<ToolDefinition, 'name' | 'description'>[],
  canRoute: boolean,
  signal: AbortSignal,
): Promise<TurnDecision | undefined> {
  const prune = Boolean(options.pruneTools) && tools.length >= (options.minToolsToPrune ?? 6)
  const route = Boolean(options.routeModel) && canRoute
  if (!prune && !route) return undefined

  const questions: Record<string, DecisionQuestion> = {}
  if (prune) {
    tools.forEach((_tool, index) => {
      questions[TOOL_KEY(index)] = {
        type: 'yesno',
        instructions: `Could \`tools.${TOOL_KEY(index)}\` be needed, at any step, to do \`task\`?`,
        yes: 'The task could plausibly call it, directly or along the way',
        no: 'The task has nothing to do with what it does',
      }
    })
  }
  if (route) {
    questions[ROUTE_KEY] = {
      type: 'choice',
      instructions: 'How demanding is `task` for the assistant doing it?',
      options: {
        light:
          'A direct answer, a lookup, or one or two simple tool calls: no multi-step plan, no code to write or change, no careful reasoning',
        heavy:
          'Several steps, writing or changing code or files, debugging, analysis, or anything where a weaker model is likely to get it wrong',
      },
    }
  }

  const evidence = {
    task,
    ...(prune
      ? {
          tools: Object.fromEntries(tools.map((tool, index) => [TOOL_KEY(index), `${tool.name}: ${tool.description}`])),
        }
      : {}),
  }

  try {
    const { answers, usage } = await options.model.decide(
      { evidence, questions },
      AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 3_000)]),
    )
    const keepAt = options.keepToolAt ?? 0.2
    const decision: TurnDecision = { llm: 'default', ...(usage ? { usage } : {}) }
    if (prune) {
      // A tool with no answer is kept: unknown is not irrelevant.
      decision.tools = tools
        .filter((_tool, index) => {
          const answer = answers[TOOL_KEY(index)]
          return answer?.type !== 'yesno' || answer.probability >= keepAt
        })
        .map((tool) => tool.name)
    }
    const routed = answers[ROUTE_KEY]
    if (route && routed?.type === 'choice' && (routed.probabilities.light ?? 0) >= (options.routeLightAt ?? 0.8)) {
      decision.llm = 'light'
    }
    return decision
  } catch (err) {
    // Cancelled by the user is not a decision failure; let the loop see it.
    if (signal.aborted) throw err
    return { llm: 'default', error: err instanceof Error ? err.message : String(err) }
  }
}
