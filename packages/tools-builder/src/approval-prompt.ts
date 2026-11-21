/**
 * Hard-gated approval for user-built tools.
 *
 * A generated spec is never saved until the user explicitly approves it.
 * The approval asks to review the spec (shell command + env args, or URL +
 * network policy) and confirms it is safe to save to the personal folder and
 * register as a dangerous-level tool.
 */
export interface ToolApprovalContext {
  toolName: string
  description: string
  specJson: string
  storagePath: string
}

export interface ToolApprovalResult {
  approved: boolean
  /** If approved, any note from the user. */
  note?: string
}

export type ToolApprovalPrompt = (ctx: ToolApprovalContext) => Promise<ToolApprovalResult>

/**
 * The default terminal approval prompt for a new tool spec.
 *
 * Shows the tool name, description, the spec (formatted), and the destination
 * folder. Asks yes/no with a reminder that the tool will be loaded only from
 * the user's folder and never marked safe.
 */
export function createToolApprovalPrompt(ask: (question: string) => Promise<string>): ToolApprovalPrompt {
  return async (ctx: ToolApprovalContext): Promise<ToolApprovalResult> => {
    const preamble =
      `\n⚠ NEW TOOL REQUESTED — must approve before saving\n` +
      `  Tool: "${ctx.toolName}"\n` +
      `  Description: ${ctx.description}\n` +
      `  Storage: ${ctx.storagePath}\n` +
      `  Spec:\n${ctx.specJson}\n` +
      `  ⚠ Built tools are NEVER safe and load ONLY from your personal folder.`

    const answer = (await ask(`${preamble}\n  Approve this spec? Save to ${ctx.storagePath}? [y/N] `))
      .trim()
      .toLowerCase()

    if (answer.startsWith('y')) {
      // Optional note
      const noteAnswer = await ask(`  Add a note about this tool? [optional, press Enter to skip] `)
      return { approved: true, note: noteAnswer.trim() || undefined }
    }
    return { approved: false }
  }
}
