import type { ToolDefinition } from '@open-agent/agent'
import type { GuiAgentFactory, GuiAgentUpdate } from './types.js'

/**
 * Delegates a task to a full computer-use agent loop (screenshot -> model
 * prediction -> mouse/keyboard action, repeated) via a `GuiAgentFactory` —
 * real usage wires this to `@ui-tars/sdk`'s `GUIAgent` + an operator such as
 * `@ui-tars/operator-nut-js` (see `createUiTarsGuiAgentFactory`). `ask`
 * permission: this is open-ended control of a real computer, the same class
 * of risk as `retry_with_browser_use_agent` in packages/tools-browser.
 */
export function computerUseTaskTool(factory: GuiAgentFactory): ToolDefinition<{ task: string }> {
  return {
    name: 'computer_use_task',
    description:
      'Delegate a task to a computer-use agent that can see the screen and control the mouse/keyboard to complete it (open, click, type, scroll across any application).',
    schema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The task to complete on the computer.' } },
      required: ['task'],
    },
    permissionLevel: 'ask',
    async execute(args, context) {
      const transcript: string[] = []
      const state: { status: GuiAgentUpdate['status'] } = { status: 'init' }

      const onUpdate = (update: GuiAgentUpdate) => {
        state.status = update.status
        for (const { from, value } of update.conversations) {
          if (from === 'gpt') transcript.push(value)
        }
      }

      try {
        const agent = factory.create(onUpdate, context.signal)
        await agent.run(args.task)
        if (state.status === 'max_loop') {
          return {
            ok: false,
            content: transcript.join('\n'),
            error: 'reached the maximum loop count without finishing',
          }
        }
        return { ok: true, content: transcript.join('\n') || '(task completed with no output)' }
      } catch (err) {
        return { ok: false, content: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
