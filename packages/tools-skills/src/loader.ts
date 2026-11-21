/**
 * Loads user-built skill files from `~/.openagent/skills/` and matches them.
 *
 * Security constraints (per issue #283):
 * - Only loads from the user's personal folder (`~/.openagent/skills/`)
 * - Never loads from system/shared locations
 * - Skill names go into system prompt via `RunOptions.context` when matched
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import type { LoadedSkill, SavedSkillFile } from './spec-types.js'

/** Path to the user's personal skill folder. */
export const USER_SKILLS_DIR = join(homedir(), '.openagent', 'skills')

/** What a failed load should say. Absent means the failure is only reported through the return value. */
export type LoadReporter = (message: string) => void

/** Load a single saved skill file. */
export async function loadSavedSkill(filePath: string): Promise<LoadedSkill | null> {
  try {
    const text = await readFile(filePath, 'utf-8')
    const file = JSON.parse(text) as SavedSkillFile
    if (file.skillVersion !== 1) return null // only version 1 supported
    if (!file.name || !file.description || !Array.isArray(file.tags) || !Array.isArray(file.steps)) {
      return null
    }
    const id = filePath
      .split(/[\\/]/)
      .pop()!
      .replace(/\.json$/, '')
    return { id, file }
  } catch {
    return null
  }
}

/** Load all skill files from the user's folder (or a supplied one, for tests). */
export async function loadUserSkills(report?: LoadReporter, dir: string = USER_SKILLS_DIR): Promise<LoadedSkill[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    // A missing folder is the normal case for someone who has never saved a
    // skill; anything else (permissions, an unreadable path) is worth saying.
    return []
  }

  const results: LoadedSkill[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const fullPath = join(dir, entry)
    // Only regular files qualify: a symlink could point anywhere on disk.
    let statResult
    try {
      statResult = lstatSync(fullPath)
    } catch {
      report?.(`Skipped ${fullPath}: could not stat entry.`)
      continue
    }
    if (!statResult.isFile()) {
      report?.(`Skipped ${fullPath}: not a regular file.`)
      continue
    }
    const loaded = await loadSavedSkill(fullPath)
    if (loaded) results.push(loaded)
    else report?.(`Skipped ${fullPath}: not a readable skillVersion 1 skill file.`)
  }
  return results
}

/**
 * Match an input string against loaded skills.
 *
 * Matches when:
 * - Any of the skill's tags appears in the input (lowercase, word‑boundary)
 * - The skill's name (kebab‑case) matches a word in the input
 * - The skill's example matches (if present)
 *
 * Returns matches sorted by confidence (highest first).
 */
export function matchSkills(
  skills: readonly LoadedSkill[],
  input: string,
): Array<{ skill: LoadedSkill; confidence: number; reason: string }> {
  const lowerInput = input.toLowerCase().trim()
  const words = lowerInput.split(/\s+/)

  const matches: Array<{ skill: LoadedSkill; confidence: number; reason: string }> = []
  for (const skill of skills) {
    let confidence = 0
    let reason = ''

    // Exact tag match: one of the skill's tags appears as a whole word in the input.
    for (const tag of skill.file.tags) {
      if (words.includes(tag.toLowerCase())) {
        confidence = 0.8
        reason = `tag "${tag}"`
        break
      }
    }

    // Partial tag match: a tag is a substring of any word.
    if (confidence === 0) {
      for (const tag of skill.file.tags) {
        if (words.some((w) => w.includes(tag.toLowerCase()))) {
          confidence = 0.6
          reason = `partial tag "${tag}"`
          break
        }
      }
    }

    // Skill ID (kebab‑case) appears as a word.
    if (confidence === 0 && words.includes(skill.id.toLowerCase())) {
      confidence = 0.9
      reason = `skill name "${skill.id}"`
    }

    // Example text matches (fuzzy).
    if (confidence === 0 && skill.file.example) {
      const lowerExample = skill.file.example.toLowerCase()
      if (lowerInput.includes(lowerExample) || lowerExample.includes(lowerInput)) {
        confidence = 0.7
        reason = `example matches`
      }
    }

    if (confidence > 0) {
      matches.push({ skill, confidence, reason })
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence)
}
