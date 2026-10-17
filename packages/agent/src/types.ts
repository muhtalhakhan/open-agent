export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface Message {
  role: Role
  content: string
  /** Present on an assistant message that is requesting tool calls. */
  toolCalls?: ToolCall[]
  /** Present on a tool-role message: which call this is the result of. */
  toolCallId?: string
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export type PermissionLevel = 'safe' | 'ask' | 'dangerous'

export interface ToolResult {
  ok: boolean
  content: string
  error?: string
}

export interface ToolDefinition<Args extends Record<string, unknown> = Record<string, unknown>> {
  name: string
  description: string
  /** JSON-schema-shaped description of arguments, for prompt assembly. */
  schema: Record<string, unknown>
  permissionLevel: PermissionLevel
  /**
   * Set when the tool's output carries content from outside the user's
   * control — a fetched page, an API response, search results.
   * `ToolRegistry` fences that output as data before the model sees it, and a
   * task that has read any stops being covered by remembered approvals, since
   * the next call might be the content's idea rather than the user's.
   */
  untrustedOutput?: boolean
  /**
   * The one host this tool sends anything to, when configuration fixes it and
   * no argument can change it: a classifier API, a search API. The
   * exfiltration rule exists to catch data leaving for a place the content
   * chose; here the arguments cannot choose, so a URL in them is payload, not
   * a destination, and the rule does not apply. Leave it unset for any tool
   * whose arguments can name where it connects.
   */
  fixedDestination?: string
  execute(args: Args, context: ToolExecutionContext): Promise<ToolResult>
  /**
   * Optional: a human-readable preview of what executing these args would
   * change — used by plan mode ("review file edits as a diff before they
   * run"). It must be read-only: it runs instead of `execute`, and a
   * side-effecting preview would defeat the point of reviewing first.
   *
   * Failures should be reported as a `{ ok: false }` result carrying the
   * same message `execute` would fail with, so a doomed call is denied
   * without prompting over it.
   */
  plan?(args: Args, context: ToolExecutionContext): Promise<ToolResult>
}

export interface ToolExecutionContext {
  taskId: string
  signal: AbortSignal
}

export interface LlmRequest {
  messages: Message[]
  tools: Pick<ToolDefinition, 'name' | 'description' | 'schema'>[]
}

/**
 * Tokens one model request consumed, as the provider reported them — what it
 * bills by. Counted by the provider rather than estimated here: tokenizers
 * differ per model, and an estimate that disagrees with the invoice is worse
 * than none.
 */
export interface TokenUsage {
  /** Everything the model read: system prompt, history, tool schemas. Includes `cachedInputTokens`. */
  inputTokens: number
  /** What it wrote, reasoning included where the provider counts it as output. */
  outputTokens: number
  /** The part of `inputTokens` served from the provider's prompt cache, usually billed at a fraction. */
  cachedInputTokens?: number
}

export interface LlmResponse {
  message: Message
  /** Absent when the provider did not report it. */
  usage?: TokenUsage
}

/**
 * Text as it arrives, for display only: none of it is logged. A `reset` takes
 * back everything shown since the last one, because a retry or a switch to a
 * fallback provider starts the answer over after part of it was already on
 * screen.
 */
export type TextStreamEvent = { type: 'delta'; text: string } | { type: 'reset' }

export interface GenerateOptions {
  /**
   * When set, an adapter that can stream calls this as text arrives. One that
   * can't ignores it. Either way `generate()` resolves with the whole
   * response, which is what gets logged.
   */
  onText?: (event: TextStreamEvent) => void
}

export interface LlmAdapter {
  name: string
  generate(request: LlmRequest, signal: AbortSignal, options?: GenerateOptions): Promise<LlmResponse>
}

/**
 * One typed judgment for a `DecisionModel`: a yes/no, a pick from fixed
 * options, or a position on an ordered scale. The answer is always one of
 * the shapes the question allows — never prose, so nothing has to be parsed.
 */
export type DecisionQuestion =
  | { type: 'yesno'; instructions: string; yes?: string; no?: string }
  /** `options` maps each label to what it means; the description is what the model judges by. */
  | { type: 'choice'; instructions: string; options: Record<string, string | null> }
  /** `levels` are ordered lowest first. */
  | { type: 'score'; instructions: string; levels: string[] }

export type DecisionAnswer =
  /** Probability that the answer is yes, 0 to 1. */
  | { type: 'yesno'; probability: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  /** `score` is a probability-weighted index into `levels`, and may fall between two of them. */
  | { type: 'score'; score: number; confidence: number }

export interface DecisionRequest {
  /**
   * What the questions are about, as text or as named parts. Questions refer
   * to a part by its path in backticks (`items.a1`), so keep the names plain.
   */
  evidence: string | Record<string, unknown>
  questions: Record<string, DecisionQuestion>
}

export interface DecisionResponse {
  /** Keyed like the questions. A question the model returned no valid answer for is absent. */
  answers: Record<string, DecisionAnswer>
  usage?: TokenUsage
}

/**
 * A model for small, typed judgments — classify, check, score, rank — that
 * is far cheaper and faster than asking the LLM in prose. The same seam as
 * `LlmAdapter`: `name` plus one method, so the agent core never knows which
 * vendor answers.
 */
export interface DecisionModel {
  name: string
  decide(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResponse>
}

/** A durable, append-only fact about a task. Session state is always a projection of this log. */
export type SessionEvent =
  | { type: 'turn/start'; taskId: string; at: number }
  | { type: 'turn/end'; taskId: string; at: number; reason: 'completed' | 'cancelled' | 'error' }
  | { type: 'step/start'; taskId: string; at: number }
  | { type: 'step/end'; taskId: string; at: number }
  | { type: 'system/message'; taskId: string; at: number; message: Message }
  | { type: 'user/message'; taskId: string; at: number; message: Message }
  | { type: 'assistant/message'; taskId: string; at: number; message: Message; usage?: TokenUsage }
  | { type: 'tool/call'; taskId: string; at: number; call: ToolCall }
  | { type: 'tool/result'; taskId: string; at: number; callId: string; result: ToolResult }
  | { type: 'retry'; taskId: string; at: number; attempt: number; reason: string }
  | {
      type: 'lease/requested'
      taskId: string
      at: number
      kind: TakeoverKind
      reason: string
      /** The site or machine a person is being asked to deal with. */
      target?: string
    }
  | { type: 'lease/returned'; taskId: string; at: number; outcome: TakeoverOutcome }

/**
 * Why control is being handed to a person: they asked for the wheel, or the
 * agent reached something only a person can do, such as a login wall.
 */
export type TakeoverKind = 'takeover' | 'login'

export interface TakeoverRequest {
  taskId: string
  kind: TakeoverKind
  /** Why, in the agent's own words, shown to the person being asked. */
  reason: string
  /** The site or machine in question, for a login. */
  target?: string
}

/**
 * How a handoff ended. Deliberately a closed set and not free text: anything
 * a person types while driving — a password above all — must have no way back
 * into the transcript. See `lease.ts`.
 */
export type TakeoverOutcome = 'completed' | 'declined' | 'cancelled' | 'unavailable' | 'busy' | 'failed'

/** Who is driving a task right now. */
export type LeaseState = { holder: 'agent' } | { holder: 'pending' | 'human'; since: number; reason: string }

export type TaskStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'error'

export interface TaskState {
  id: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  error?: string
}
