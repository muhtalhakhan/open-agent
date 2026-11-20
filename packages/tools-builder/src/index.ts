/**
 * Export the full tool-builder package.
 *
 * Key exports:
 * - Spec format: `ToolSpec`, `ShellToolSpec`, `HttpToolSpec`
 * - Builder: `buildShellTool`, `buildHttpTool` (always produces `permissionLevel: 'dangerous'`)
 * - Approval: `createToolApprovalPrompt`, `approveAndSaveTool`
 * - Loader: `loadUserTools`, `mountUserBuiltTools`, `USER_TOOLS_DIR`
 * - Authoring: `createToolTool` (the agent-facing "create new tool on request" tool)
 */

export * from './spec-types.js'
export * from './approval-prompt.js'
export * from './approval-flow.js'
export * from './builder.js'
export type { LoadReporter } from './loader.js'
export * from './loader.js'
export * from './create-tool.js'
