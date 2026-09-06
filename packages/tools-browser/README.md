# @open-agent/tools-browser

Browser tools backed by [browser-use](https://github.com/browser-use/browser-use)'s own MCP server (`python -m browser_use.mcp`), via `@open-agent/tools-mcp`. This is the "mixed adoption" call from `docs/architecture.md`: browser automation is a real dependency, not reimplemented from scratch.

## Setup

Requires Python 3.11+ and browser-use installed and reachable on the configured command (defaults to `python3 -m browser_use.mcp`):

```bash
uv add browser-use   # or: pip install browser-use
```

## What you get

The `browser-use` MCP server exposes granular browser-control tools. This fills in Milestone 3 (Browser): navigation, click, type, scroll, screenshot, and DOM-inspection tools all come from here rather than a hand-rolled Playwright wrapper.

The full list of tools provided:

- **Navigation & Actions**: `browser_navigate`, `browser_click`, `browser_type`, `browser_scroll`
- **State & Content**: `browser_get_state`, `browser_extract_content`, `browser_get_html`, `browser_screenshot`
- **Tabs**: `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`
- **Session/Delegation**: `browser_close_session`, `browser_close_all`, `retry_with_browser_use_agent` (delegates a stuck task to browser-use's own autonomous agent as a last resort)

## Isolation

Each run gets a **fresh profile directory**, provisioned before the MCP server starts and removed when it stops. The agent's browser therefore begins with no cookies, no saved passwords and no history — nothing for a visited page, or an instruction hidden in one, to reach.

Sharing your real profile is a coherent thing to want (some tasks need a logged-in session) but it should be a sentence someone wrote rather than the default they got, so it is opt-in:

```ts
mountBrowserUseTools(registry, { profileDir: '/home/u/.config/google-chrome' })
```

That is a browser already logged into your email, your bank and your source control, and every one of those sessions is reachable by whatever the agent browses. A shared profile is never deleted on dispose — it is the user's directory.

The profile is passed to browser-use through environment variables, and their _names_ belong to browser-use rather than to us. `DEFAULT_PROFILE_ENV_VARS` sets several spellings at once (they cost nothing, and setting only the one that stopped being read is a silent failure), and `profileEnvVars` overrides the list if a future version reads something else — a config change for an operator instead of a patch release from us.

**Credentials are kept out of the subprocess.** browser-use is a third-party program, and anything it prints comes back as tool output; it has no business seeing the API keys the agent runs on. `spawnMcpServer` credential-filters the inherited environment, with `allowEnv` for a variable a server genuinely needs.

What this does _not_ do: the browser process itself is not sandboxed. A compromised browser has the same reach as the user running the agent.

## Permission policy

Navigating, clicking, typing, scrolling, and reading page state are `safe` — they can't reach the filesystem or a shell. `retry_with_browser_use_agent` (open-ended delegation to another agent) and closing sessions (`browser_close_session`/`browser_close_all`) are `ask`. See `src/browser-use.ts` for the full mapping and rationale.

## Example (Manual Wiring)

```ts
import { Context } from '@open-agent/context'
import { toolsPlugin } from '@open-agent/agent'
import { withContext } from '@open-agent/tools-browser'

const ctx = new Context()
ctx.plugin(toolsPlugin)
const dispose = await withContext(ctx) // spawns `python3 -m browser_use.mcp`, registers its tools on ctx.tools

// ... run the agent loop; browser tools are now available ...

dispose() // unregisters the tools and closes the MCP subprocess
```

## Example (Plugin Wiring)

For standard application setup, you can mount it alongside other plugins like the agent loop:

```ts
import { Context } from '@open-agent/context'
import { toolsPlugin } from '@open-agent/agent'
import { browserToolsPlugin } from '@open-agent/tools-browser'

const ctx = new Context()
ctx.plugin(toolsPlugin)
ctx.plugin(browserToolsPlugin()) // automatically waits for toolsPlugin, spawns MCP, registers tools

// The context's lifecycle manages the subprocess automatically:
ctx.dispose() // shuts down MCP and cleans up
```

`src/browser-use.test.ts` runs against a fake MCP server in `test-fixtures/` that mimics a slice of browser-use's real tool list, so the permission-policy mapping and registry wiring are tested end to end without needing Python or browser-use installed in CI.
