import { randomUUID } from 'node:crypto'
import type { SessionLog } from './session.js'
import type { ToolRegistry } from './tools.js'
import type { Logger } from './logger.js'
import { silentLogger } from './logger.js'
import type {
  GenerateOptions,
  LlmAdapter,
  LlmResponse,
  TaskState,
  TextStreamEvent,
  ToolAttachment,
  ToolCall,
  ToolDefinition,
} from './types.js'
import { UNTRUSTED_CONTENT_GUIDANCE, isFenced } from './untrusted.js'
import { decideTurn, type DecisionLayerOptions } from './decision-layer.js'

export class CancelledError extends Error {
  constructor() {
    super('task was cancelled')
    this.name = 'CancelledError'
  }
}

export interface RunOptions {
  /**
   * Additional standing context for this turn — recalled memories, retrieved
   * documents, anything the caller assembled that is *about* the task rather
   * than part of it.
   *
   * It joins the configured `systemPrompt` in the system message instead of
   * being spliced into the user's text, so the logged user message stays
   * exactly what the user typed. That matters twice over: the transcript
   * stays faithful, and context can't be mistaken for the request itself.
   */
  context?: string
  /**
   * Streams the model's text as it is generated, for a person watching. Gets
   * an adapter's `delta`s and `reset`s, a `reset` of its own before every
   * retry, and an `end` once a reply is complete, which is where one model
   * message stops and the next (after a tool call) begins.
   *
   * Display only. The log still records each reply whole, once it is
   * complete, so nothing about transcripts or `--resume` changes.
   */
  onText?: (event: RunTextEvent) => void
  /**
   * What tools show while they run — a browser's screenshots — for a person
   * watching. Display only, and so neither logged nor sent to the model; see
   * `ToolExecutionContext.onAttachment`.
   */
  onAttachment?: (attachment: ToolAttachment, call: ToolCall) => void
}

export type RunTextEvent = TextStreamEvent | { type: 'end' }

export interface AgentLoopOptions {
  llm: LlmAdapter
  tools: ToolRegistry
  sessions: SessionLog
  /**
   * Standing instructions prepended to every turn as a `system` message —
   * project conventions, most of all. Appended to the session log like any
   * other model-visible fact rather than injected at request time, so what
   * the model saw stays reconstructable from the log alone.
   */
  systemPrompt?: string
  /** Safety valve against a runaway tool-calling loop. */
  maxSteps?: number
  /**
   * A cheaper model for turns the decision layer judges light. Same tools,
   * same log; only who answers changes.
   */
  lightLlm?: LlmAdapter
  /** Decides per turn which tools to offer and whether `lightLlm` will do. Off unless given. */
  decisions?: DecisionLayerOptions
  maxRetries?: number
  retryDelayMs?: number
  logger?: Logger
}

/**
 * A step is one model request plus the tools it calls. A turn is the whole
 * run: it opens on the incoming message and closes once the model produces
 * a final answer, the task is cancelled, or it errors out. Every fact about
 * what happened is appended to the session log first — the loop itself
 * holds no state that isn't reconstructable from that log.
 */
export class AgentLoop {
  private readonly maxSteps: number
  private readonly maxRetries: number
  private readonly retryDelayMs: number
  private readonly logger: Logger

  constructor(private readonly options: AgentLoopOptions) {
    this.maxSteps = options.maxSteps ?? 25
    this.maxRetries = options.maxRetries ?? 2
    this.retryDelayMs = options.retryDelayMs ?? 250
    this.logger = options.logger ?? silentLogger
  }

  async run(
    input: string,
    signal: AbortSignal,
    taskId: string = randomUUID(),
    options: RunOptions = {},
  ): Promise<TaskState> {
    const { sessions, tools } = this.options
    const startedAt = Date.now()
    const task: TaskState = { id: taskId, status: 'running', createdAt: startedAt, updatedAt: startedAt }

    sessions.append({ type: 'turn/start', taskId, at: Date.now() })
    // Standing instructions and per-turn context share one system message:
    // conventions first, then whatever the caller assembled for this turn.
    // Appended before the user message so it lands first in the derived
    // history, and only when this task has no system message yet: a resumed
    // taskId would otherwise accumulate a copy per run().
    // The fence guidance rides along only when some tool can produce fenced
    // output; otherwise it would describe markers the model never sees.
    const guidance = tools.list().some((tool) => tool.untrustedOutput) ? UNTRUSTED_CONTENT_GUIDANCE : undefined
    const systemContent = [this.options.systemPrompt, guidance, options.context]
      .map((part) => part?.trim())
      .filter((part): part is string => Boolean(part))
      .join('\n\n')
    if (systemContent && !sessions.all(taskId).some((e) => e.type === 'system/message')) {
      sessions.append({
        type: 'system/message',
        taskId,
        at: Date.now(),
        message: { role: 'system', content: systemContent },
      })
    }
    sessions.append({ type: 'user/message', taskId, at: Date.now(), message: { role: 'user', content: input } })
    this.logger.info('turn/start', { taskId })

    // The registry forgets a task's taint when its turn ends, but the content
    // stays in the conversation. A task continued from its log — a follow-up
    // turn, or a session resumed in a new process — has read it all the same.
    if (sessions.all(taskId).some((e) => e.type === 'tool/result' && isFenced(e.result))) tools.taint(taskId)

    // Same reasoning for the sequence rules: what the task has already read,
    // and which destinations are unremarkable by now, are facts about the
    // conversation rather than about one turn of it.
    tools.replayTask(taskId, sessions.all(taskId))

    try {
      // Decided once, before the first request, and logged before it is
      // acted on: the turn's tool list and model are part of what the model
      // saw, so the transcript has to say what they were.
      let llm = this.options.llm
      let offered = (all: ToolDefinition[]) => all
      if (this.options.decisions) {
        const decision = await decideTurn(
          this.options.decisions,
          input,
          tools.list(),
          this.options.lightLlm !== undefined,
          signal,
        )
        if (decision) {
          sessions.append({ type: 'turn/decision', taskId, at: Date.now(), ...decision })
          this.logger.info('turn/decision', {
            taskId,
            tools: decision.tools?.length,
            llm: decision.llm,
            error: decision.error,
          })
          if (decision.llm === 'light' && this.options.lightLlm) llm = this.options.lightLlm
          if (decision.tools) {
            const keep = new Set(decision.tools)
            offered = (all) => all.filter((tool) => keep.has(tool.name))
          }
        }
      }

      for (let step = 0; step < this.maxSteps; step++) {
        if (signal.aborted) throw new CancelledError()

        sessions.append({ type: 'step/start', taskId, at: Date.now() })
        const messages = sessions.deriveMessages(taskId)
        const response = await this.generateWithRetry(
          llm,
          messages,
          offered(tools.list()),
          signal,
          taskId,
          options.onText,
        )

        sessions.append({
          type: 'assistant/message',
          taskId,
          at: Date.now(),
          message: response.message,
          ...(response.usage ? { usage: response.usage } : {}),
        })

        const toolCalls = response.message.toolCalls ?? []
        if (toolCalls.length === 0) {
          sessions.append({ type: 'step/end', taskId, at: Date.now() })
          // Task-scoped approvals die with the task. One that outlived it
          // would be a session-scoped approval the user never agreed to.
          tools.endTask(taskId)
          sessions.append({ type: 'turn/end', taskId, at: Date.now(), reason: 'completed' })
          this.logger.info('turn/end', { taskId, reason: 'completed', steps: step + 1 })
          return { ...task, status: 'completed', updatedAt: Date.now() }
        }

        for (const call of toolCalls) {
          if (signal.aborted) throw new CancelledError()
          sessions.append({ type: 'tool/call', taskId, at: Date.now(), call })
          // Untrusted output arrives already fenced (see ToolRegistry.execute),
          // so the log holds exactly what the model will be shown.
          const onAttachment = options.onAttachment
          const result = await tools.execute(call, {
            taskId,
            signal,
            ...(onAttachment ? { onAttachment: (attachment: ToolAttachment) => onAttachment(attachment, call) } : {}),
          })
          sessions.append({ type: 'tool/result', taskId, at: Date.now(), callId: call.id, result })
          this.logger.info('tool/result', { taskId, tool: call.name, ok: result.ok })
        }
        sessions.append({ type: 'step/end', taskId, at: Date.now() })
      }

      throw new Error(`exceeded maxSteps (${this.maxSteps}) without a final answer`)
    } catch (err) {
      const reason = err instanceof CancelledError ? 'cancelled' : 'error'
      tools.endTask(taskId)
      sessions.append({ type: 'turn/end', taskId, at: Date.now(), reason })
      this.logger.error('turn/end', { taskId, reason, error: err instanceof Error ? err.message : String(err) })
      return {
        ...task,
        status: reason,
        updatedAt: Date.now(),
        error: reason === 'error' ? (err instanceof Error ? err.message : String(err)) : undefined,
      }
    }
  }

  private async generateWithRetry(
    llm: LlmAdapter,
    messages: Parameters<LlmAdapter['generate']>[0]['messages'],
    toolDefs: Parameters<LlmAdapter['generate']>[0]['tools'],
    signal: AbortSignal,
    taskId: string,
    onText?: (event: RunTextEvent) => void,
  ): Promise<LlmResponse> {
    // A broken display must not fail the task: the callback only mirrors what
    // the log will hold anyway, so its errors are logged and dropped rather
    // than mistaken for a provider failure and retried.
    const emit = onText
      ? (event: RunTextEvent) => {
          try {
            onText(event)
          } catch (err) {
            this.logger.warn('onText', { taskId, error: err instanceof Error ? err.message : String(err) })
          }
        }
      : undefined
    // Without a listener adapters take their non-streaming path, so print
    // mode and background jobs make exactly the requests they always did.
    const generateOptions: GenerateOptions | undefined = emit ? { onText: emit } : undefined

    let attempt = 0
    for (;;) {
      if (signal.aborted) throw new CancelledError()
      try {
        // A failed attempt may have streamed half an answer before it died.
        if (attempt > 0) emit?.({ type: 'reset' })
        const response = await llm.generate({ messages, tools: toolDefs }, signal, generateOptions)
        emit?.({ type: 'end' })
        return response
      } catch (err) {
        attempt++
        if (attempt > this.maxRetries) throw err
        const reason = err instanceof Error ? err.message : String(err)
        this.options.sessions.append({ type: 'retry', taskId, at: Date.now(), attempt, reason })
        this.logger.warn('retry', { taskId, attempt, reason })
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt))
      }
    }
  }
}
