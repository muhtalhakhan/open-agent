import type { GuiAgentFactory, GuiAgentLike, GuiAgentUpdate } from './types.js'

export interface UiTarsModelConfig {
  baseURL: string
  apiKey: string
  model: string
}

export interface UiTarsAdapterOptions {
  model: UiTarsModelConfig
  maxLoopCount?: number
}

/**
 * Real GuiAgentFactory backed by `@ui-tars/sdk`'s GUIAgent and
 * `@ui-tars/operator-nut-js`'s NutJSOperator (native OS mouse/keyboard/
 * screenshot control — see https://github.com/bytedance/UI-TARS-desktop).
 *
 * These are peer packages, not a hard dependency of @open-agent/tools-computer:
 * nut-js needs native bindings and a real display, which most CI/server
 * environments don't have. Install them yourself to use this adapter:
 *
 *   npm install @ui-tars/sdk @ui-tars/operator-nut-js
 *
 * `computer-use-tool.ts` and its tests only depend on the GuiAgentFactory
 * interface, so nothing else in this package requires these to be installed.
 */
export function createUiTarsGuiAgentFactory(options: UiTarsAdapterOptions): GuiAgentFactory {
  return {
    create(onUpdate: (update: GuiAgentUpdate) => void, signal?: AbortSignal): GuiAgentLike {
      return {
        async run(instruction: string): Promise<void> {
          const [{ GUIAgent }, { NutJSOperator }] = await Promise.all([
            // @ts-expect-error optional peer dependency, not installed by this package
            import('@ui-tars/sdk'),
            // @ts-expect-error optional peer dependency, not installed by this package
            import('@ui-tars/operator-nut-js'),
          ])

          await new Promise<void>((resolve, reject) => {
            const agent = new GUIAgent({
              model: options.model,
              operator: new NutJSOperator(),
              signal,
              maxLoopCount: options.maxLoopCount,
              onData: ({ data }: { data: GuiAgentUpdate }) => {
                onUpdate(data)
                if (data.status === 'end' || data.status === 'max_loop') resolve()
              },
              onError: ({ error }: { error: unknown }) => {
                reject(error instanceof Error ? error : new Error(String(error)))
              },
            })
            agent.run(instruction).catch(reject)
          })
        },
      }
    },
  }
}
