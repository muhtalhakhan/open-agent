/**
 * The user-facing approval prompt and save mechanism.
 *
 * A generated spec must pass the approval prompt before it is saved.
 * The loader then registers it from `~/.openagent/tools/`.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { USER_TOOLS_DIR } from './loader.js'
import {
  createToolApprovalPrompt,
  type ToolApprovalPrompt,
  type ToolApprovalResult,
  type ToolApprovalContext,
} from './approval-prompt.js'
import type { ToolSpec, SavedToolFile } from './spec-types.js'

/** Save an approved spec to the user's folder (or a supplied one, for tests). */
export async function saveApprovedTool(
  name: string,
  description: string,
  spec: ToolSpec,
  note?: string,
  dir: string = USER_TOOLS_DIR,
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${name}.json`)
  const saved: SavedToolFile = {
    specVersion: 1,
    spec,
    approvedAt: new Date().toISOString(),
    note,
  }
  await writeFile(filePath, JSON.stringify(saved, null, 2), 'utf-8')
  return filePath
}

/** The combined flow: show spec, ask approval, save. */
export async function approveAndSaveTool(
  prompt: ToolApprovalPrompt,
  name: string,
  description: string,
  spec: ToolSpec,
  note?: string,
  dir: string = USER_TOOLS_DIR,
): Promise<{ saved: boolean; path?: string; result?: ToolApprovalResult }> {
  const specJson = JSON.stringify(spec, null, 2)
  const filePath = join(dir, `${name}.json`)
  // Folder existence check not required before approval prompt — prompt reveals storage path
  const ctx: ToolApprovalContext = { toolName: name, description, specJson, storagePath: filePath }
  const result = await prompt(ctx)
  if (!result.approved) return { saved: false, result }
  const path = await saveApprovedTool(name, description, spec, result.note ?? note, dir)
  return { saved: true, path, result }
}

export { createToolApprovalPrompt, USER_TOOLS_DIR }
export type { ToolApprovalPrompt, ToolApprovalResult, ToolApprovalContext }
