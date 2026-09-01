# @open-agent/tools-computer

Computer-use tools backed by [UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop)'s `@ui-tars/sdk` (a GUIAgent driving a screenshot -> model-prediction -> mouse/keyboard-action loop) and `@ui-tars/operator-nut-js` (native OS control via [nut-js](https://github.com/nut-tree/nut-js)).

## Why this isn't a hard dependency

`@ui-tars/sdk` and `@ui-tars/operator-nut-js` are **not** dependencies of this package. `@ui-tars/operator-nut-js` needs native bindings and a real display — most CI runners and servers have neither, and forcing that install on every consumer of this package (even ones only using browser/memory tools) would be hostile. Install them yourself to use the real adapter:

```bash
npm install @ui-tars/sdk @ui-tars/operator-nut-js
```

Everything else in this package (the tools themselves, their tests) only depends on the `GuiAgentFactory`/`ScreenshotOperator` interfaces in `src/types.ts`, so it installs and tests cleanly without either package present.

## What you get

- **`computerUseTaskTool(factory)`** — delegates a task to a full computer-use agent loop (see it, click it, type it, scroll it, across any application). `ask` permission: this is open-ended control of a real computer, the same class of risk as `retry_with_browser_use_agent` in `@open-agent/tools-browser`.
- **`computerScreenshotTool(operator)`** — standalone, `safe` screenshot capture, independent of the full agent loop.
- **`createUiTarsGuiAgentFactory(options)`** — the real `GuiAgentFactory`, dynamically importing `@ui-tars/sdk`/`@ui-tars/operator-nut-js` at call time so this package still loads without them installed.

## Example

```ts
import { computerUseTaskTool, computerScreenshotTool, createUiTarsGuiAgentFactory } from '@open-agent/tools-computer'

const factory = createUiTarsGuiAgentFactory({
  model: { baseURL: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o' },
})

registry.register(computerUseTaskTool(factory))
// registry.register(computerScreenshotTool(operator)) — needs a ScreenshotOperator, e.g. `new NutJSOperator()`
```

Tests use a fake `GuiAgentFactory`/`ScreenshotOperator` (`src/*.test.ts`) since a real run needs a display and native bindings that CI doesn't have.
