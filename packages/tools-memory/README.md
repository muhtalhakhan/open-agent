# @open-agent/tools-memory

Agent memory tools: `remember`, `recall`, `forget`, and `list_memories` (issue #282).

## What are memory tools?

These tools give the agent direct control over long-term memory:

- **`remember`**: save a durable fact, preference, or snippet to long-term memory mid-task.
- **`recall`**: search memory for relevant facts, preferences, or past context by similarity or keywords mid-task.
- **`forget`**: forget an outdated or requested memory by ID or exact content match.
- **`list_memories`**: list recent memories in the current container to inspect what is stored.

All tools are scoped to the container tag the CLI uses (`process.env.CLI_USER_ID ?? 'cli-user'`).

## Security model

- All memory tools run at `safe` permission level: memory operations are confined to the user's container within the configured `MemoryProvider`.
- No external network access unless the memory provider itself connects to a configured remote backend (e.g. Supermemory or Mem0 with user API key).

## Usage

```ts
import { mountMemoryTools, rememberTool, recallTool, forgetTool, listMemoriesTool } from '@open-agent/tools-memory'

// Mount all memory tools to a ToolRegistry:
const dispose = mountMemoryTools(tools, memoryProvider, containerTag)
```
