/**
 * Builds the context string for matched skills to inject into `RunOptions.context`.
 *
 * Per issue #283:
 * "Skills come from the user's own folder only, never from a repository, and
 * their names (not contents) go into the system prompt via RunOptions.context."
 */
import type { LoadedSkill } from './spec-types.js'
import { matchSkills } from './loader.js'

export interface SkillMatchResult {
  skill: LoadedSkill
  confidence: number
  reason: string
}

/**
 * Given all loaded skills and user input, find matching skills and build
 * a context string containing their names and descriptions (NOT full content).
 *
 * Returns undefined if no skills match, so it doesn't pollute the context.
 */
export function buildSkillContext(
  skills: readonly LoadedSkill[],
  input: string,
  minConfidence: number = 0.6,
): string | undefined {
  if (skills.length === 0) return undefined

  const matches = matchSkills(skills, input).filter((m) => m.confidence >= minConfidence)
  if (matches.length === 0) return undefined

  const lines = ['Relevant skills from your personal library:']
  for (const { skill } of matches) {
    lines.push(`- ${skill.id}: ${skill.file.description}`)
  }
  lines.push('Use the `read_skill` tool to view the full procedure steps if needed.')

  return lines.join('\n')
}
