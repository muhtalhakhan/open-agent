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
