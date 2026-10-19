/**
 * What the server streams to the browser over `GET /api/events`. Shared by
 * both ends, and deliberately free of imports: the client is compiled for the
 * browser, and pulling in `@open-agent/agent` would pull Node into it.
 */

/** The model's text as it is generated — `RunTextEvent` from the agent, restated. */
export type TextEvent = { type: 'delta'; text: string } | { type: 'reset' } | { type: 'end' }

export type TaskEndStatus = 'completed' | 'cancelled' | 'error'

/** `TokenUsage` from the agent, restated: what a task cost, as the provider reported it. */
export interface Usage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
}

/** How long an approval lasts: this call, the rest of this task, or the rest of the session. */
export type ApprovalScope = 'once' | 'task' | 'session'

export type ServerEvent =
  /**
   * Opens every connection. Everything after it up to the live edge is a
   * replay, so a client that reconnects starts again from empty rather than
   * appending a second copy of the conversation.
   */
  | { type: 'hello' }
  /** Something the operator should see that is not part of a task's answer: a tool that loaded, a call denied. */
  | { type: 'notice'; text: string }
  | { type: 'task/start'; taskId: string; input: string }
  | { type: 'text'; taskId: string; event: TextEvent }
  /** A new model request within the turn: step 1 is the first, each tool round adds one. */
  | { type: 'step'; taskId: string; step: number }
  /** The provider failed and the loop is trying again; any text streamed since the last step is taken back by a `text` reset. */
  | { type: 'retry'; taskId: string; attempt: number; reason: string }
  /** `args` is already clipped: a `write_file` call's arguments can be the whole file. */
  | { type: 'tool/start'; taskId: string; callId: string; name: string; args: string }
  /** `output` is the start of what a successful call returned, for a person to glance at, not the whole of it. */
  | { type: 'tool/end'; taskId: string; callId: string; ok: boolean; error?: string; output?: string; ms: number }
  | { type: 'task/end'; taskId: string; status: TaskEndStatus; answer: string; error?: string; usage?: Usage }
  /**
   * A tool call waiting for the person: answered with
   * `POST /api/approvals/<approvalId>`. Replayed to a tab that connects while
   * it is pending, so a reload never strands the agent waiting on nobody.
   */
  | {
      type: 'approval/request'
      taskId: string
      approvalId: string
      tool: string
      level: 'safe' | 'ask' | 'dangerous'
      /** Pretty-printed JSON, clipped only at a length no reviewer reads past. */
      args: string
      /** The answers worth offering; the server refuses any other. */
      scopes: ApprovalScope[]
      /** Present when a sequence rule held a call its own level would have let through; the reason leads. */
      escalation?: { rule: string; reason: string }
      /** Plan mode: the diff of what the call would change. Approving it is approving the change. */
      planPreview?: string
    }
  | { type: 'approval/resolved'; taskId: string; approvalId: string; approved: boolean; scope?: ApprovalScope }

/** One past task in `GET /api/history`: `TaskRecord` from the agent, restated, with the answer cut to a preview. */
export interface HistoryTask {
  taskId: string
  /** The saved session it belongs to; absent for a task from the session still running. */
  sessionId?: string
  prompt: string
  /** `interrupted` means it started and never ended: the process died mid-task. */
  status: 'completed' | 'cancelled' | 'error' | 'interrupted'
  startedAt: number
  endedAt?: number
  answer?: string
  toolCalls: number
  usage?: Usage
}

/**
 * `GET /api/history/<task>`: the task's transcript as the same events the
 * live stream sends, so the page draws a past task exactly as it drew it live.
 */
export interface HistoryTranscript {
  task: HistoryTask
  events: ServerEvent[]
}

/** One stored memory, as the memory view shows it. */
export interface MemoryRecord {
  id: string
  content: string
  /** Present for a search result: how closely it matched. */
  score?: number
  metadata?: Record<string, unknown> | null
}

/** `GET /api/memory?q=`: what the agent remembers for this user, all of it or what matches `q`. */
export interface MemoryListing {
  provider: string
  containerTag: string
  /** Whether the backend can list everything; when it cannot, the view has to search. */
  canList: boolean
  query: string
  items: MemoryRecord[]
}

/**
 * One setting as the settings view shows it. A secret's value never leaves
 * the server: the page learns only whether it is set, and where.
 */
export interface SettingView {
  name: string
  label: string
  kind: 'url' | 'text' | 'secret' | 'toggle' | 'choice'
  help?: string
  /** For a `choice`: the values it takes. `''` means unset. */
  options?: string[]
  /** The current value, for anything but a secret. */
  value?: string
  /**
   * Where the running value comes from. `shell` means an environment
   * variable set before `.env` was read, which `.env` cannot override — the
   * page cannot change it either.
   */
  source: 'env-file' | 'keychain' | 'shell' | 'unset'
}

export interface SettingsGroup {
  id: string
  title: string
  description: string
  settings: SettingView[]
}

/** `GET /api/settings`. */
export interface SettingsView {
  /** The `.env` the CLI reads, and so the one changes are written to. */
  envPath: string
  /** Where new keys go: the keychain's name when one is configured, else `.env`. */
  secretStore: string
  groups: SettingsGroup[]
  /** Set once a change was saved: the running agent still has the old settings until it restarts. */
  restartNeeded: boolean
}

/** `POST /api/settings`: names to new values, `null` to remove. Only what changed. */
export interface SettingsChanges {
  changes: Record<string, string | null>
}
