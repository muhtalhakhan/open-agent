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
  /**
   * What a tool showed while it ran: the browser's page after an action.
   * Display only — never logged, never seen by the model — and sent live
   * only, with the latest one repeated to a tab that connects mid-task.
   */
  | { type: 'screen'; taskId: string; mimeType: string; data: string; caption?: string }
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

/** The tools a profile can switch on or off — `PROFILE_TOOLS` in the CLI, restated. */
export type ProfileTool = 'browser' | 'computer' | 'http' | 'files' | 'shell'

/** The fields of a profile, as the editor sends them. A tool left out takes its `.env` setting. */
export interface ProfileFields {
  name: string
  model: string
  tools: Partial<Record<ProfileTool, boolean>>
}

/** One profile file, as the profiles view shows it. */
export interface ProfileView extends ProfileFields {
  /** The file name without `.yaml`: what `--profile` takes, and how the page refers to it. */
  id: string
  /** `example` profiles live in the checkout and are read-only here; duplicate one to change it. */
  origin: 'user' | 'example'
  /** Set when the file does not load: it is listed so the person can find it, but not offered for use. */
  error?: string
}

/** `GET /api/profiles`. */
export interface ProfilesView {
  /** The folder the person's own profiles are written to. */
  dir: string
  /** What `.env` gives when no profile is applied: what each tool left out of a profile falls back to. */
  base: { model: string; tools: Record<ProfileTool, boolean> }
  /**
   * Tools the page can turn off in a profile but not on. They reach the whole
   * machine, and like the shell setting in the settings view, turning them on
   * is for the profile file or the terminal.
   */
  restricted: ProfileTool[]
  /** The profile the running agent was started with, as it was named; absent when none. */
  running?: string
  /** The profile every start uses when no `--profile` is given. `locked` when the shell sets it. */
  defaultProfile?: { id: string; locked: boolean }
  profiles: ProfileView[]
  /** Shared with the settings view: something was saved that the running agent does not have yet. */
  restartNeeded: boolean
}

/** `POST /api/profiles`. Each one is checked and applied by the host, which may refuse it. */
export type ProfileAction =
  /** `create` writes a new file and never replaces one; without it, an existing profile of the person's is replaced. */
  | { action: 'save'; id: string; profile: ProfileFields; create: boolean }
  | { action: 'duplicate'; id: string; newId: string }
  | { action: 'delete'; id: string }
  /** `null` clears the default. */
  | { action: 'default'; id: string | null }
