import type {
  GuiAgentFactory,
  GuiAgentLike,
  GuiAgentUpdate,
  ScreenshotOperator,
  ScreenshotOutput,
  WindowOperator,
  WindowInfo,
} from './types.js'

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

/**
 * A ScreenshotOperator backed by the same `@ui-tars/operator-nut-js` peer
 * package `createUiTarsGuiAgentFactory` drives. Kept lazy for the same
 * reason: the native bindings need a real display, so importing eagerly
 * would break headless environments that never take a screenshot.
 *
 * If the peer isn't installed, the import rejects and `computerScreenshotTool`
 * surfaces that as a tool error rather than crashing the agent.
 */
export function createNutJsScreenshotOperator(): ScreenshotOperator {
  return {
    async screenshot(): Promise<ScreenshotOutput> {
      // @ts-expect-error optional peer dependency, not installed by this package
      const { NutJSOperator } = await import('@ui-tars/operator-nut-js')
      return (await new NutJSOperator().screenshot()) as ScreenshotOutput
    },
  }
}

/**
 * A WindowOperator backed by `@ui-tars/operator-nut-js`'s native window-management
 * APIs. Kept lazy for the same reason as `createNutJsScreenshotOperator`: the
 * native bindings need a real display, so importing eagerly would break headless
 * environments.
 *
 * If the peer isn't installed, the import rejects and the window tools surface
 * that as a tool error rather than crashing the agent.
 *
 * Note: the actual API surface of `@ui-tars/operator-nut-js` for window
 * operations is determined by what that package exposes — this adapter maps
 * the `WindowOperator` interface onto whatever nut-js provides (window App,
 * window title, etc.). Adjust the field-mapping below to match the actual
 * nut-js API shape once it is installed.
 */
export function createNutJsWindowOperator(): WindowOperator {
  return {
    async list(): Promise<WindowInfo[]> {
      // @ts-expect-error optional peer dependency, not installed by this package
      const { NutJSOperator } = await import('@ui-tars/operator-nut-js')
      const op = new NutJSOperator()
      // nut-js exposes window-management via its App/Window objects.
      // Map whatever it provides onto our WindowInfo interface.
      // Adjust field names here once nut-js types are available locally.

      const getWindows = (op as any).getWindows
      if (typeof getWindows !== 'function') {
        throw new Error(
          'window_list is not supported by the installed @ui-tars/operator-nut-js version (missing getWindows).',
        )
      }

      const windows: any[] = (await getWindows.call(op)) ?? []
      return windows
        .map((w: any): WindowInfo => ({
          id: String(w.id ?? w.hwnd ?? w.handle ?? ''),
          title: String(w.title ?? w.text ?? ''),
          appName: String(w.appName ?? w.processName ?? w.process?.name ?? ''),
          bounds: {
            x: w.bounds?.x ?? w.x ?? 0,
            y: w.bounds?.y ?? w.y ?? 0,
            width: w.bounds?.width ?? w.width ?? 0,
            height: w.bounds?.height ?? w.height ?? 0,
          },
          isFocused: Boolean(w.isFocused ?? w.focused ?? w.isActive),
          isMinimized: Boolean(w.isMinimized ?? w.minimized),
        }))
        .filter((w) => w.id.length > 0)
    },

    async screenshot(windowId: string): Promise<ScreenshotOutput> {
      // @ts-expect-error optional peer dependency, not installed by this package
      const { NutJSOperator } = await import('@ui-tars/operator-nut-js')
      const op = new NutJSOperator()

      const screenshotWindow = (op as any).screenshotWindow
      if (typeof screenshotWindow !== 'function') {
        throw new Error(
          'window_screenshot is not supported by the installed @ui-tars/operator-nut-js version (missing screenshotWindow).',
        )
      }
      return (await screenshotWindow.call(op, windowId)) as ScreenshotOutput
    },

    async focus(windowId: string): Promise<void> {
      // @ts-expect-error optional peer dependency, not installed by this package
      const { NutJSOperator } = await import('@ui-tars/operator-nut-js')
      const op = new NutJSOperator()

      if (typeof (op as any).focusWindow === 'function') {
        await (op as any).focusWindow(windowId)
      } else {
        // Fallback: activate via mouse click at window center
        const wins = await this.list()
        const target = wins.find((w) => w.id === windowId)
        if (!target) throw new Error(`Window ${windowId} not found`)
        const cx = target.bounds.x + target.bounds.width / 2
        const cy = target.bounds.y + target.bounds.height / 2

        await (op as any).mouse?.click?.(cx, cy)
      }
    },

    async setBounds(
      windowId: string,
      bounds: { x?: number; y?: number; width?: number; height?: number },
    ): Promise<void> {
      // @ts-expect-error optional peer dependency, not installed by this package
      const { NutJSOperator } = await import('@ui-tars/operator-nut-js')
      const op = new NutJSOperator()

      if (typeof (op as any).setWindowBounds === 'function') {
        await (op as any).setWindowBounds(windowId, bounds)
      } else if (typeof (op as any).moveWindow === 'function') {
        await (op as any).moveWindow(windowId, bounds)
      } else {
        throw new Error(
          `setBounds is not supported by the installed @ui-tars/operator-nut-js version. ` +
            `Please update to a version that exposes window move/resize APIs.`,
        )
      }
    },
  }
}
