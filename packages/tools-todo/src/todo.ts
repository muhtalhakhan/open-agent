import type { SessionEvent, ToolDefinition, ToolResult } from '@open-agent/agent'

export const TODO_TOOL = 'todo_write'

export type TodoStatus = 'pending' | 'in_progress' | 'done'

export interface TodoItem {
  content: string
  status: TodoStatus
}

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'done']
/** A plan longer than this is a backlog, not a working list. */
const MAX_ITEMS = 50
const MAX_CONTENT_CHARS = 300

const SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: 'The whole list, in order. Each call replaces the previous list.',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The step, as a short imperative ("Add tests for the parser").' },
          status: { type: 'string', enum: [...STATUSES] },
        },
        required: ['content', 'status'],
      },
    },
  },
  required: ['todos'],
}

export type ParsedTodos = { ok: true; todos: TodoItem[] } | { ok: false; error: string }

/** Checks a call's arguments. Shared by the tool and the views, so a list they show is one the tool accepted. */
export function parseTodos(args: Record<string, unknown>): ParsedTodos {
  const list = args.todos
  if (!Array.isArray(list)) return { ok: false, error: 'todos must be a list' }
  if (list.length > MAX_ITEMS) return { ok: false, error: `todos has ${list.length} items; keep it to ${MAX_ITEMS}` }
  const todos: TodoItem[] = []
  for (const [index, item] of list.entries()) {
    const { content, status } = (item ?? {}) as Record<string, unknown>
    if (typeof content !== 'string' || !content.trim()) return { ok: false, error: `todo ${index + 1} needs content` }
    if (content.length > MAX_CONTENT_CHARS) {
      return { ok: false, error: `todo ${index + 1} is longer than ${MAX_CONTENT_CHARS} characters` }
    }
    if (!STATUSES.includes(status as TodoStatus)) {
      return { ok: false, error: `todo ${index + 1}: status must be one of ${STATUSES.join(', ')}` }
    }
    todos.push({ content: content.trim(), status: status as TodoStatus })
  }
  // One step at a time is what makes the list say where the work is.
  if (todos.filter((todo) => todo.status === 'in_progress').length > 1) {
    return { ok: false, error: 'only one todo can be in_progress at a time' }
  }
  return { ok: true, todos }
}

const MARK: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[>]', done: '[x]' }

/** `[x] Read the parser` lines, the same for the model's result and the terminal. */
export function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '(empty)'
  return todos.map((todo) => `${MARK[todo.status]} ${todo.content}`).join('\n')
}

/**
 * A checklist the agent keeps for work with several steps: it writes the
 * plan, marks a step in progress before starting it and done after, and the
 * person watching sees where it is.
 *
 * Stateless on purpose. The list lives in the session log, as this call's
 * arguments: views rebuild it from there with `trackTodos`, so a past task
 * replays with the list it had, and nothing reaches the model that the log
 * does not hold. `safe`: it changes nothing outside the conversation.
 */
export function todoWriteTool(): ToolDefinition<{ todos: unknown }> {
  return {
    name: TODO_TOOL,
    description:
      'Keep a todo list for a task with several steps. Send the whole list each time: write the plan first, mark ' +
      'one step in_progress before starting it and done when it is finished, and add steps you discover. Skip it ' +
      'for a task that takes one or two steps.',
    schema: SCHEMA,
    permissionLevel: 'safe',
    async execute(args): Promise<ToolResult> {
      const parsed = parseTodos(args)
      if (!parsed.ok) return { ok: false, content: '', error: parsed.error }
      const done = parsed.todos.filter((todo) => todo.status === 'done').length
      return { ok: true, content: `Todo list (${done}/${parsed.todos.length} done):\n${formatTodos(parsed.todos)}` }
    },
  }
}

/**
 * Follows a session log and reports each task's list whenever a
 * `todo_write` call succeeds. A refused or failed call changes nothing: the
 * list shown is always one the tool accepted.
 */
export function trackTodos(onChange: (taskId: string, todos: TodoItem[]) => void): (event: SessionEvent) => void {
  const pending = new Map<string, TodoItem[]>()
  return (event) => {
    if (event.type === 'tool/call' && event.call.name === TODO_TOOL) {
      const parsed = parseTodos(event.call.args)
      if (parsed.ok) pending.set(event.call.id, parsed.todos)
    } else if (event.type === 'tool/result') {
      const todos = pending.get(event.callId)
      if (!todos) return
      pending.delete(event.callId)
      if (event.result.ok) onChange(event.taskId, todos)
    }
  }
}
