# @open-agent/tools-skills

User-initiated skill creation (issue #283).

## What is a skill?

A **skill** is a reusable procedure the agent has learned — step-by-step instructions for a recurring task ("how to release this repo", "debug network connectivity", "setup a new contributor").

When the agent recognizes a task that matches a skill (by tag or name), the skill's steps are injected into the system context, helping the agent follow the proven procedure.

## Security model

- Skills are **never** loaded from system or shared locations — only `~/.openagent/skills/`
- Skills are **safe** permission level (reads/writes config, no external effects)
- Skill **names** (not content) go into the system prompt when matched
- The user's own folder only; no injection from repo or shared sources

## Usage

```ts
import { saveSkillTool, listSkillsTool, loadUserSkills, matchSkills } from '@open-agent/tools-skills'
```

## Skill file format

```json
{
  "skillVersion": 1,
  "name": "release-repo",
  "description": "Release this repository to npm",
  "tags": ["release", "npm", "git", "version-bump"],
  "steps": [
    { "action": "Run `npm version patch` to bump version" },
    { "action": "Review the changes with git diff" },
    { "action": "Run `git commit -m \"chore: release v{x}.{y}.{z}\"`" },
    { "action": "Run `git push origin main && npm publish`" }
  ],
  "example": "How do I release this repo?",
  "createdAt": "2026-01-15T10:30:00Z",
  "updatedAt": "2026-01-15T10:30:00Z"
}
```

## Tools

- `save_skill` — Agent saves a new skill after completing a multi-step task
- `list_skills` — Lists available skills, optionally filtered by tag