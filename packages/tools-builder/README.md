# @open-agent/tools-builder

User-initiated tool creation (issue #285).

## Security model

- Built tools are **never** `safe`; always `dangerous`.
- Load **only** from `~/.openagent/tools/` — never from system or shared locations.
- Arguments for shell commands are passed as **environment variables**, never string-spliced into the command string.
- HTTP requests are constrained by a `NetworkPolicy` (allowed/denied hosts, local access).
- A **hard approval gate** requires user approval before any spec is saved.

## Usage

```ts
import {
  buildShellTool,
  createToolApprovalPrompt,
  approveAndSaveTool,
  mountUserBuiltTools,
} from '@open-agent/tools-builder'
```
