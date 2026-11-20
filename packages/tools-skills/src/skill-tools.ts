/**
 * The agent-facing skill tools.
 *
 * - `save_skill`: Save a new skill from the agent's proposed steps
 * - `list_skills`: List available skills from the user's folder
 * - `read_skill`: Read the full procedure of a skill by name
 *
 * Skills are stored as JSON in `~/.openagent/skills/<name>.json`.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolDefinition, ToolResult, ToolExecutionContext } from '@open-agent/agent'
import { USER_SKILLS_DIR, loadUserSkills } from './loader.js'
import type { SavedSkillFile, SkillStep } from './spec-types.js'

export const SAVE_SKILL_NAME = 'save_skill'
export const LIST_SKILLS_NAME = 'list_skills'
export const READ_SKILL_NAME = 'read_skill'

const SAVE_SKILL_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        'Kebab-case name for the skill (e.g., "release-repo", "setup-contributor"). ' +
        'Becomes the filename under ~/.openagent/skills/.',
    },
    description: {
      type: 'string',
      description: 'One-line description of what this skill accomplishes.',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Tags to match incoming tasks. Lowercase kebab-case. ' + 'Example: ["release", "git", "version-bump"].',
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Short imperative: "Run `npm version patch`"' },
          detail: { type: 'string', description: 'Optional details or context.' },
        },
        required: ['action'],
      },
      description: 'Procedure steps, as a numbered list of actions.',
    },
    example: {
      type: 'string',
      description: 'Optional example user request that triggers this skill.',
    },
    note: {
      type: 'string',
      description: 'Optional note about why this skill exists (private, not shown to model).',
    },
  },
  required: ['name', 'description', 'tags', 'steps'],
}

const LIST_SKILLS_SCHEMA = {
  type: 'object',
  properties: {
    tag: {
      type: 'string',
      description: 'Optional tag to filter skills by (shows only skills with this tag).',
    },
  },
}

const READ_SKILL_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'The skill name / ID to read (e.g., "release-repo").',
    },
  },
  required: ['name'],
}

/** Validate and parse the proposed skill steps. */
function parseSteps(steps: unknown): SkillStep[] | null {
  if (!Array.isArray(steps)) return null
  const parsed: SkillStep[] = []
  for (const step of steps) {
    if (typeof step !== 'object' || step === null) continue
    const s = step as Record<string, unknown>
    if (typeof s.action !== 'string' || !s.action.trim()) continue
    parsed.push({
      action: s.action.trim(),
      ...(typeof s.detail === 'string' && s.detail.trim() ? { detail: s.detail.trim() } : {}),
    })
  }
  return parsed.length > 0 ? parsed : null
}

/** Sanitize the skill name (kebab-case). */
function sanitizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Fail with a message. */
function fail(error: string): ToolResult {
  return { ok: false, content: '', error }
}

/**
 * The `save_skill` tool: agent saves a reusable procedure for recurring tasks.
 *
 * Security: Always safe (reads/writes config, no external effects). Skills are
 * loaded from the user's folder only, so no injection risk.
 */
export function saveSkillTool(): ToolDefinition<Record<string, unknown>> {
  return {
    name: SAVE_SKILL_NAME,
    description:
      'Save a reusable procedure ("skill") that the agent can reuse for recurring tasks. ' +
      'Use this when you complete a multi-step task and want to remember the steps for later. ' +
      'The skill will be loaded when a future task matches its tags or name. ' +
      'Saved to ~/.openagent/skills/ — private to this user, never shared.',
    schema: SAVE_SKILL_SCHEMA,
    permissionLevel: 'safe',
    async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
      const name = sanitizeName(String(args.name ?? ''))
      if (!name) return fail('a skill name is required')
      if (name.length < 3) return fail('skill name must be at least 3 characters')
      if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) {
        return fail('skill name must be kebab-case: lowercase letters, digits and dashes')
      }

      const description = String(args.description ?? '').trim()
      if (!description) return fail('a description is required')
      if (description.length > 200) return fail('description must be 200 characters or less')

      const tagsRaw = Array.isArray(args.tags) ? args.tags : []
      const tags = tagsRaw
        .map((t) =>
          String(t)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, ''),
        )
        .filter((t) => t.length > 0 && t.length < 50)
      if (tags.length === 0) return fail('at least one tag is required')
      if (tags.length > 10) return fail('at most 10 tags are allowed')

      const steps = parseSteps(args.steps)
      if (!steps || steps.length === 0) return fail('at least one step is required')
      if (steps.length > 50) return fail('at most 50 steps are allowed')

      const example = args.example ? String(args.example).trim() : undefined
      const note = args.note ? String(args.note).trim() : undefined

      const now = new Date().toISOString()
      const skill: SavedSkillFile = {
        skillVersion: 1,
        name: description.split('.')[0] || name,
        description,
        tags,
        steps,
        example,
        createdAt: now,
        updatedAt: now,
        note,
      }

      await mkdir(USER_SKILLS_DIR, { recursive: true })
      const filePath = join(USER_SKILLS_DIR, `${name}.json`)
      await writeFile(filePath, JSON.stringify(skill, null, 2), 'utf-8')

      return {
        ok: true,
        content:
          `Saved skill "${name}" to ${filePath}.\n` +
          `Tags: ${tags.join(', ')}\n` +
          `Steps: ${steps.length}\n` +
          `The skill will be loaded when a future task matches these tags or the skill name.`,
      }
    },
  }
}

/**
 * The `list_skills` tool: list available skills, optionally filtered by tag.
 *
 * Security: Always safe (read-only, no external effects).
 */
export function listSkillsTool(): ToolDefinition<Record<string, unknown>> {
  return {
    name: LIST_SKILLS_NAME,
    description:
      'List the skills available in your personal skill library. ' +
      'Skills are reusable procedures you have saved for recurring tasks. ' +
      'Optionally filter by a tag to see only skills matching that topic.',
    schema: LIST_SKILLS_SCHEMA,
    permissionLevel: 'safe',
    async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
      const tag = args.tag ? String(args.tag).trim().toLowerCase() : undefined
      const skills = await loadUserSkills()

      if (skills.length === 0) {
        return { ok: true, content: 'No skills saved yet. Use save_skill to create one.' }
      }

      const filtered = tag ? skills.filter((s) => s.file.tags.some((t) => t.toLowerCase() === tag)) : skills

      if (filtered.length === 0) {
        return { ok: true, content: `No skills found with tag "${tag}".` }
      }

      const lines = [`${filtered.length} skill(s):\n`]
      for (const s of filtered) {
        lines.push(`## ${s.id}`)
        lines.push(`  ${s.file.description}`)
        lines.push(`  Tags: ${s.file.tags.join(', ')}`)
        lines.push(`  Steps: ${s.file.steps.length}`)
        if (s.file.example) lines.push(`  Example: "${s.file.example}"`)
        lines.push('')
      }

      return { ok: true, content: lines.join('\n') }
    },
  }
}

/**
 * The `read_skill` tool: read the full step-by-step procedure of a specific skill.
 *
 * Security: Always safe (read-only, no external effects).
 */
export function readSkillTool(): ToolDefinition<Record<string, unknown>> {
  return {
    name: READ_SKILL_NAME,
    description:
      'Read the full step-by-step procedure of a saved skill by its name. ' +
      'Use this when a skill summary or match points to a procedure you need to execute.',
    schema: READ_SKILL_SCHEMA,
    permissionLevel: 'safe',
    async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
      const name = sanitizeName(String(args.name ?? ''))
      if (!name) return fail('a skill name is required')

      const skills = await loadUserSkills()
      const found = skills.find((s) => s.id === name)
      if (!found) return fail(`skill "${name}" not found in your personal library`)

      const f = found.file
      const lines = [
        `# Skill: ${found.id}`,
        `Description: ${f.description}`,
        `Tags: ${f.tags.join(', ')}`,
        `Created: ${f.createdAt}`,
        '',
        '## Procedure Steps:',
      ]
      for (const [i, step] of f.steps.entries()) {
        lines.push(`${i + 1}. ${step.action}`)
        if (step.detail) lines.push(`   Note: ${step.detail}`)
      }
      if (f.example) {
        lines.push('', `Example: "${f.example}"`)
      }

      return { ok: true, content: lines.join('\n') }
    },
  }
}
