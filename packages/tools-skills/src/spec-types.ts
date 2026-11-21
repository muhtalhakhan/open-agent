/**
 * Specification format for user-built skills.
 *
 * A skill is a reusable procedure the agent has learned: steps for a recurring
 * task ("how to release this repo", "debug network connectivity", "setup a new
 * contributor"). Saved to the user's folder; skill names (not content) go into
 * the system prompt via `RunOptions.context` when a task matches.
 */

/** A step in the skill procedure. */
export interface SkillStep {
  /** Short imperative describing what to do. */
  action: string
  /** Optional details, tool calls, or decisions to make. */
  detail?: string
}

/** A saved skill file at `~/.openagent/skills/<name>.json`. */
export interface SavedSkillFile {
  /** Version of the skill format (for future migration). */
  skillVersion: number
  /** The skill's human-readable name (display only). */
  name: string
  /** One-line description of what this skill achieves. */
  description: string
  /** Tags used to match incoming tasks. Lowercase kebab-case. */
  tags: readonly string[]
  /** The procedure steps, as a numbered list of actions. */
  steps: readonly SkillStep[]
  /** Optional example of a user request that triggers this skill. */
  example?: string
  /** When the skill was created (ISO 8601). */
  createdAt: string
  /** When the skill was last updated (ISO 8601). */
  updatedAt: string
  /** Optional user note about why the skill exists. */
  note?: string
}

/** A skill as loaded from disk and ready to match. */
export interface LoadedSkill {
  /** Kebab-case identifier, derived from the filename. */
  id: string
  /** The saved file's full content. */
  file: SavedSkillFile
}

/** The result of matching an input against a skill. */
export interface SkillMatch {
  skill: LoadedSkill
  /** Match confidence (0–1), based on tag overlap or text similarity. */
  confidence: number
  /** The match reason (which tags matched, any trigger phrase). */
  reason: string
}
