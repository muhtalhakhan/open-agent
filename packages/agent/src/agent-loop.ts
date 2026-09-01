import { randomUUID } from 'node:crypto'
import type { SessionLog } from './session.js'
import type { ToolRegistry } from './tools.js'
import type { Logger } from './logger.js'
import { silentLogger } from './logger.js'
import type { LlmAdapter, LlmResponse, TaskState } from './types.js'

export class CancelledError extends Error {
  constructor() {
    super('task was cancelled')
    this.name = 'CancelledError'
  }
}

export interface AgentLoopOptions {
  llm: LlmAdapter
  tools: ToolRegistry
  sessions: SessionLog
  /** Safety valve against a runaway tool-calling loop. */
  maxSteps?: number
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

  async run(input: string, signal: AbortSignal, taskId: string = randomUUID()): Promise<TaskState> {
    const { sessions, tools, llm } = this.options
    const startedAt = Date.now()
    const task: TaskState = { id: taskId, status: 'running', createdAt: startedAt, updatedAt: startedAt }

    sessions.append({ type: 'turn/start', taskId, at: Date.now() })
    sessions.append({ type: 'user/message', taskId, at: Date.now(), message: { role: 'user', content: input } })
    this.logger.info('turn/start', { taskId })

    try {
      for (let step = 0; step < this.maxSteps; step++) {
        if (signal.aborted) throw new CancelledError()

        sessions.append({ type: 'step/start', taskId, at: Date.now() })
        const messages = sessions.deriveMessages(taskId)
        const response = await this.generateWithRetry(messages, tools.list(), signal, taskId)

        sessions.append({ type: 'assistant/message', taskId, at: Date.now(), message: response.message })

        const toolCalls = response.message.toolCalls ?? []
        if (toolCalls.length === 0) {
          sessions.append({ type: 'step/end', taskId, at: Date.now() })
          sessions.append({ type: 'turn/end', taskId, at: Date.now(), reason: 'completed' })
          this.logger.info('turn/end', { taskId, reason: 'completed', steps: step + 1 })
          return { ...task, status: 'completed', updatedAt: Date.now() }
        }

        for (const call of toolCalls) {
          if (signal.aborted) throw new CancelledError()
          sessions.append({ type: 'tool/call', taskId, at: Date.now(), call })
          const result = await tools.execute(call, { taskId, signal })
          sessions.append({ type: 'tool/result', taskId, at: Date.now(), callId: call.id, result })
          this.logger.info('tool/result', { taskId, tool: call.name, ok: result.ok })
        }
        sessions.append({ type: 'step/end', taskId, at: Date.now() })
      }

      throw new Error(`exceeded maxSteps (${this.maxSteps}) without a final answer`)
    } catch (err) {
      const reason = err instanceof CancelledError ? 'cancelled' : 'error'
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
    messages: Parameters<LlmAdapter['generate']>[0]['messages'],
    toolDefs: Parameters<LlmAdapter['generate']>[0]['tools'],
    signal: AbortSignal,
    taskId: string,
  ): Promise<LlmResponse> {
    let attempt = 0
    for (;;) {
      if (signal.aborted) throw new CancelledError()
      try {
        return await this.options.llm.generate({ messages, tools: toolDefs }, signal)
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
