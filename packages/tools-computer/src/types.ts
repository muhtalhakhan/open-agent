/** Mirrors `@ui-tars/sdk/core`'s `ScreenshotOutput` — our own copy so this package has no hard dependency on it. */
export interface ScreenshotOutput {
  /** Base64-encoded image. */
  base64: string
  /** Device pixel ratio. */
  scaleFactor: number
}

/** The subset of `@ui-tars/sdk/core`'s `Operator` interface a screenshot tool needs. */
export interface ScreenshotOperator {
  screenshot(): Promise<ScreenshotOutput>
}

/** One streamed update from a running GUIAgent turn (mirrors its `onData` callback shape). */
export interface GuiAgentUpdate {
  conversations: Array<{ from: 'human' | 'gpt' | 'screenshotBase64'; value: string }>
  status: 'init' | 'running' | 'end' | 'max_loop'
}

/**
 * The narrow slice of `@ui-tars/sdk`'s `GUIAgent` this package drives: a
 * single natural-language instruction in, resolves once the loop reaches a
 * terminal status. Real usage constructs an actual `GUIAgent` (with a
 * `NutJSOperator` or similar) via `createUiTarsGuiAgentFactory`; tests
 * inject a fake.
 */
export interface GuiAgentLike {
  run(instruction: string): Promise<void>
}

export interface GuiAgentFactory {
  /** Builds a fresh GUIAgent wired to call `onUpdate` for every streamed conversation delta. */
  create(onUpdate: (update: GuiAgentUpdate) => void, signal?: AbortSignal): GuiAgentLike
}

/** Describes a single open OS window. */
export interface WindowInfo {
  /** Platform-specific window handle (hwnd on Windows, window ID on macOS). */
  id: string
  /** Visible window title. */
  title: string
  /** Name of the application that owns this window (e.g. "Chrome", "Code"). */
  appName: string
  /** Current pixel bounds relative to the primary display top-left. */
  bounds: { x: number; y: number; width: number; height: number }
  /** Whether this window is currently focused. */
  isFocused: boolean
  /** Whether this window is minimised to the taskbar. */
  isMinimized: boolean
}

/** The operations the window-management adapter must implement. */
export interface WindowOperator {
  /** Returns all open windows visible on the desktop. */
  list(): Promise<WindowInfo[]>
  /** Captures a screenshot of the specified window. */
  screenshot(windowId: string): Promise<ScreenshotOutput>
  /** Brings the window to the foreground. */
  focus(windowId: string): Promise<void>
  /** Moves and/or resizes the window. Pass undefined to leave a dimension unchanged. */
  setBounds(windowId: string, bounds: { x?: number; y?: number; width?: number; height?: number }): Promise<void>
}
