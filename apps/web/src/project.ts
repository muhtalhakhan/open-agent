import type { SessionEvent, TokenUsage } from '@open-agent/agent'
import type { ServerEvent } from './protocol.js'

const ARGS_LENGTH = 200
const ERROR_LENGTH = 300
/** Enough to see what came back — the first lines of a file, a command's output — without shipping a whole page of it. */
const OUTPUT_LENGTH = 2_000
/** A past answer in full can be a whole report; the transcript has it, the list only needs to recognise it. */
const PREVIEW_LENGTH = 200

export function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

export const preview = (text: string) => clip(text.replace(/\s+/g, ' ').trim(), PREVIEW_LENGTH)

/**
 * Turns what a task does — steps, retries, tool calls, decision-layer
 * choices — into the stream's events, as the session log records them. A
 * call is paired with its result by id, timed by the distance between the
 * two, and closed with the turn's reason if the turn ended first (cancelled
 * mid-tool), so nothing shows as running forever.
 *
 * Shared by the live stream and the history replay, so a past task reads
 * exactly as it did while it ran. The model's own text is not here: live it
 * arrives streamed, and in a replay it comes from the logged replies.
 */
export function activityProjector(taskId: string, emit: (event: ServerEvent) => void): (event: SessionEvent) => void {
  const open = new Map<string, number>()
  let step = 0
  return (event) => {
    if (event.type === 'turn/start') {
      step = 0
    } else if (event.type === 'step/start') {
      emit({ type: 'step', taskId, step: ++step })
    } else if (event.type === 'retry') {
      emit({ type: 'retry', taskId, attempt: event.attempt, reason: clip(event.reason, ERROR_LENGTH) })
    } else if (event.type === 'turn/decision') {
      emit({ type: 'notice', text: describeDecision(event) })
    } else if (event.type === 'tool/call') {
      open.set(event.call.id, event.at)
      emit({
        type: 'tool/start',
        taskId,
        callId: event.call.id,
        name: event.call.name,
        args: Object.keys(event.call.args).length ? clip(JSON.stringify(event.call.args), ARGS_LENGTH) : '',
      })
    } else if (event.type === 'tool/result') {
      const startedAt = open.get(event.callId)
      if (startedAt === undefined) return
      open.delete(event.callId)
      const { ok, error, content } = event.result
      emit({
        type: 'tool/end',
        taskId,
        callId: event.callId,
        ok,
        ...(ok
          ? content
            ? { output: clip(content, OUTPUT_LENGTH) }
            : {}
          : { error: clip(error ?? content, ERROR_LENGTH) }),
        ms: event.at - startedAt,
      })
    } else if (event.type === 'turn/end') {
      for (const [callId, startedAt] of open) {
        emit({ type: 'tool/end', taskId, callId, ok: false, error: event.reason, ms: event.at - startedAt })
      }
      open.clear()
    }
  }
}

/** One line on what the decision layer chose, so a past transcript says which tools and model the turn had. */
function describeDecision(event: Extract<SessionEvent, { type: 'turn/decision' }>): string {
  if (event.error) return `Decision layer skipped (${event.error}): all tools, default model.`
  const tools = event.tools ? `${event.tools.length} tool${event.tools.length === 1 ? '' : 's'} offered` : 'all tools'
  return `Decision layer: ${tools}, ${event.llm === 'light' ? 'light' : 'default'} model.`
}

/**
 * A stored task's log as the events the live stream would have sent for it:
 * each user message opens a turn, each reply is one finished piece of text,
 * and each turn closes with how it ended and what it cost. A turn the log
 * never closed — the process died mid-task — is closed here as interrupted,
 * rather than left looking like it is still running.
 *
 * System messages are left out: they are conventions and recalled context
 * assembled for the model, not part of the conversation the user had.
 */
export function replayTask(taskId: string, events: SessionEvent[]): ServerEvent[] {
  const out: ServerEvent[] = []
  const emit = (event: ServerEvent) => void out.push(event)
  const activity = activityProjector(taskId, emit)
  let open = false
  let answer = ''
  let usage: TokenUsage | undefined

  for (const event of events) {
    if (event.taskId !== taskId) continue
    activity(event)
    if (event.type === 'user/message') {
      if (open) emit({ type: 'task/end', taskId, status: 'error', answer: '', error: 'interrupted' })
      open = true
      answer = ''
      usage = undefined
      emit({ type: 'task/start', taskId, input: event.message.content })
    } else if (event.type === 'assistant/message') {
      if (event.usage) {
        usage ??= { inputTokens: 0, outputTokens: 0 }
        usage.inputTokens += event.usage.inputTokens
        usage.outputTokens += event.usage.outputTokens
        if (event.usage.cachedInputTokens !== undefined) {
          usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + event.usage.cachedInputTokens
        }
      }
      if (event.message.content) {
        answer = event.message.content
        emit({ type: 'text', taskId, event: { type: 'delta', text: event.message.content } })
        emit({ type: 'text', taskId, event: { type: 'end' } })
      }
    } else if (event.type === 'turn/end') {
      open = false
      emit({
        type: 'task/end',
        taskId,
        status: event.reason,
        answer: event.reason === 'completed' ? answer : '',
        ...(usage ? { usage } : {}),
      })
    }
  }
  if (open) {
    emit({
      type: 'task/end',
      taskId,
      status: 'error',
      answer: '',
      error: 'interrupted: no outcome was recorded',
      ...(usage ? { usage } : {}),
    })
  }
  return out
}
