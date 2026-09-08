import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SessionEvent } from './types.js'

/**
 * The directory where session logs are stored.
 * Uses the OS temp dir by default, but can be overridden via the `base` option.
 */
const DEFAULT_SESSION_BASE = path.join(os.tmpdir(), '.open-agent', 'sessions')

/**
 * A persisted session record on disk.
 */
export interface StoredSession {
  /** The session ID (also the directory name). */
  id: string
  /** When this session was created. */
  createdAt: number
  /** When this session was last updated. */
  updatedAt: number
  /** The append-only event log. */
  events: SessionEvent[]
}

/**
 * Options for opening or creating a session store.
 */
export interface SessionStoreOptions {
  /** Base directory for session storage (default: OS temp/.open-agent/sessions). */
  base?: string
  /** Whether to create the base directory if it doesn't exist (default: true). */
  createBase?: boolean
}

/**
 * SessionStore handles persisting and loading SessionLog events to/from disk.
 *
 * Each session gets its own directory under the base path. The directory name
 * is the session ID. The session log is stored as a single JSON file
 * (`session.json`) inside that directory for atomic reads/writes.
 */
export class SessionStore {
  private readonly base: string

  constructor(options: SessionStoreOptions = {}) {
    this.base = path.resolve(options.base ?? DEFAULT_SESSION_BASE)
  }

  /**
   * Ensure the base directory exists.
   */
  private async ensureBase(): Promise<void> {
    await fs.mkdir(this.base, { recursive: true })
  }

  /**
   * Generate a new session ID.
   */
  static generateId(): string {
    return `session_${randomBytes(8).toString('hex')}`
  }

  /**
   * Get the directory path for a session ID.
   */
  private sessionDir(id: string): string {
    if (id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
      throw new Error(`session id "${id}" must be a single path segment`)
    }
    return path.join(this.base, id)
  }

  /**
   * Get the session file path for a session ID.
   */
  private sessionFile(id: string): string {
    return path.join(this.sessionDir(id), 'session.json')
  }

  /**
   * Save a session's events to disk.
   * Creates the session directory if it doesn't exist.
   */
  async save(id: string, events: SessionEvent[], createdAt: number): Promise<void> {
    await this.ensureBase()
    const dir = this.sessionDir(id)
    await fs.mkdir(dir, { recursive: true })

    const stored: StoredSession = {
      id,
      createdAt,
      updatedAt: Date.now(),
      events,
    }

    // Write atomically: write to temp file then rename
    const file = this.sessionFile(id)
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(stored, null, 2), 'utf8')
    await fs.rename(tmp, file)
  }

  /**
   * Load a session's events from disk.
   * Returns null if the session doesn't exist.
   */
  async load(id: string): Promise<StoredSession | null> {
    try {
      const file = this.sessionFile(id)
      const content = await fs.readFile(file, 'utf8')
      const stored = JSON.parse(content) as StoredSession
      return stored
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  /**
   * Delete a session from disk.
   */
  async delete(id: string): Promise<void> {
    const dir = this.sessionDir(id)
    await fs.rm(dir, { recursive: true, force: true })
  }

  /**
   * List all session IDs, sorted by last updated (most recent first).
   */
  async list(): Promise<string[]> {
    try {
      await this.ensureBase()
      const entries = await fs.readdir(this.base, { withFileTypes: true })
      const dirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('session_'))
      // Sort by mtime descending (most recent first)
      const withTimes = await Promise.all(
        dirs.map(async (e) => {
          const stats = await fs.stat(path.join(this.base, e.name))
          return { id: e.name, mtime: stats.mtimeMs }
        }),
      )
      return withTimes.sort((a, b) => b.mtime - a.mtime).map((e) => e.id)
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return []
      }
      throw err
    }
  }

  /**
   * Get the most recent session ID, or null if none exist.
   */
  async mostRecent(): Promise<string | null> {
    const sessions = await this.list()
    return sessions[0] ?? null
  }

  /**
   * Get the base directory path.
   */
  getBase(): string {
    return this.base
  }
}
