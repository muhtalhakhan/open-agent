# Security Model

> **Status:** this document describes the target design (tracked as Milestone 9). The `permissionLevel` (`safe`/`ask`/`dangerous`) on every `ToolDefinition` is implemented and enforced today in `packages/agent`'s tool registry — see `docs/agent-design.md`. Everything else below (approval UI, sandboxing, secret store, prompt-injection defenses, audit logs) is design-only; `packages/security` has no implementation yet. Don't go looking for code that isn't there.

## Threat surface

An OpenAgent instance may, depending on its profile:

- Execute arbitrary shell commands
- Read/write files
- Control a browser with a real, authenticated session
- Control a real computer (mouse/keyboard/screen)
- Call external APIs (email, calendar, payments, etc.)
- Ingest untrusted content from the web, files, and tool output into the model's context

The two main risks are (1) the agent taking a harmful or irreversible action, and (2) untrusted content the agent reads (a web page, a file, an email) manipulating the agent into taking an unintended action — prompt injection.

## Permission model

Every tool declares a `permissionLevel`:

- `safe` — runs without confirmation (e.g. reading a file inside the workspace, taking a screenshot).
- `ask` — requires human approval by default (e.g. sending an email, running a shell command, writing outside the workspace, making a purchase).
- `dangerous` — requires explicit opt-in in the agent profile before it can even be offered to the model (e.g. `rm -rf`-equivalent operations, modifying system files, disabling security controls).

A profile can override defaults per tool (e.g. downgrade `shell.execute` to `safe` for a fully sandboxed, disposable container). Overrides are explicit and logged.

## Approval flow

1. Agent proposes a tool call requiring `ask`.
2. Runtime pauses the task and surfaces the proposed action (tool, arguments, rationale) to the user via the UI.
3. User approves, denies, or edits the arguments.
4. Decision is logged with a timestamp and the exact arguments executed.

Approvals can be scoped: "approve this once," "approve this tool for this task," or "always approve this tool for this profile" (the last one should require an explicit, separate confirmation since it removes future prompts).

## Sandboxing

- Shell execution defaults to a container/VM with no access to the host filesystem beyond the declared workspace.
- Browser automation uses a dedicated, isolated browser profile — not the user's real logged-in browser — unless the user explicitly configures profile sharing.
- Network access from sandboxed execution can be restricted (allowlist/denylist of domains) per profile.

## Secrets

- API keys and credentials are stored outside of model-visible context (env vars / secret store), injected only at the point a tool executes, and redacted from logs.
- The model never sees raw API keys, even for tools that use them internally.

## Prompt-injection defenses

- Content fetched from the web/files/tool output is tagged as untrusted data in context and instructed (via system prompt + guardrails) not to be treated as instructions.
- Tool calls triggered as a direct consequence of untrusted content should be held to the same `ask`/`dangerous` thresholds as user-initiated ones — untrusted content cannot itself elevate permissions.
- Dangerous-action detection: a lightweight classifier/heuristic layer can flag suspicious tool-call sequences (e.g. "read email → then send email to new external address") for extra scrutiny even if individual steps are `safe`.

## Audit logs

Every tool invocation is logged with: timestamp, profile, tool name, arguments, permission level, approval decision (if any), and result/error. Logs are stored locally by default and are the user's data.

## Privacy controls

Users can view, export, and delete conversation history, task history, and long-term memory. Memory writes should be inspectable, not silent.
