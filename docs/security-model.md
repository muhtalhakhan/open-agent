# Security Model

> **Status:** this document describes the target design (tracked as Milestone 9). The `permissionLevel` (`safe`/`ask`/`dangerous`) on every `ToolDefinition` is implemented and enforced today in `packages/agent`'s tool registry — see `docs/agent-design.md`. Shell sandboxing (#86) and the on-disk secret policy (#59) are implemented too, in `packages/tools-terminal` and `packages/tools-files` respectively; each carries a status note below. The rest (approval UI, secret store, prompt-injection defenses, audit logs) is design-only, and `packages/security` still has no implementation. Don't go looking for code that isn't there.

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

> **Status:** implemented (#178). An `ApprovalHandler` may return
> `{ approved, scope, match }` instead of a boolean; `ToolRegistry` remembers the
> answer for the task or the session and clears task-scoped grants at `turn/end`.
> A grant covers the _exact arguments_ by default rather than the whole tool —
> "approve run_command for this task" would otherwise mean every later command
> runs unprompted, which is close to having no approval at all. `dangerous` calls
> are never remembered, whatever the handler answers. The audit log records
> whether a call was `granted` by a human or `remembered` from an earlier answer,
> and `listApprovals()`/`revokeApprovals()` make what is remembered visible and
> reversible. The CLI prompt offers once / task / always, with `always` confirmed
> separately. Profile-scoped grants wait on profiles existing.

## Sandboxing

- Shell execution defaults to a container/VM with no access to the host filesystem beyond the declared workspace.

> **Status:** implemented for the shell tools (#86). `packages/tools-terminal` runs
> every command under a `Sandbox` — bubblewrap where the kernel allows it, otherwise
> Docker — with the filesystem read-only apart from the workspace and the network
> off unless `SHELL_NETWORK=1`. Backends are probed by _running_ them, not by
> looking for the binary, because `bwrap` is installed on plenty of machines that
> deny it the namespaces it needs. There is no automatic fall-through to running
> unsandboxed: if no backend works the shell tools are not registered at all, and
> `SHELL_SANDBOX=none` has to be set deliberately. Browser isolation (#87) and the
> provider-neutral sandbox interface (#136) are still design-only.

- Browser automation uses a dedicated, isolated browser profile — not the user's real logged-in browser — unless the user explicitly configures profile sharing.

> **Status:** implemented (#87). `packages/tools-browser` provisions a fresh profile
> directory per run and removes it afterwards, so the agent's browser starts with no
> cookies, no saved passwords and no history for a visited page to reach. Sharing is
> opt-in by naming a directory (`BROWSER_PROFILE_DIR`), and the CLI says out loud
> when a run is sharing one. Separately, MCP subprocesses no longer inherit the
> agent's credentials: `spawnMcpServer` credential-filters the environment, so
> browser-use — a third-party program whose output comes back as tool output — does
> not receive the API keys the agent runs on. What is _not_ done: the browser itself
> is not sandboxed, so a compromised browser process has the same reach as the user.

- Network access from sandboxed execution can be restricted (allowlist/denylist of domains) per profile.

> **Status:** partly implemented (#89). The policy itself lives in
> `@open-agent/agent` (`checkUrl`, `checkResolvedAddresses`) and `http_request`
> enforces it: allowlist, denylist, and — the part that needed no configuration to
> matter — loopback, private and link-local destinations refused by default, so an
> agent handed a URL by a page it just read cannot fetch
> `http://169.254.169.254/…` and return the cloud credentials as tool output.
> Redirects are followed manually and every hop is vetted again, and a hostname is
> checked against the addresses it actually resolves to.
>
> What is **not** covered: `run_command` and the browser get network on or off,
> not per-host rules. A container gets `--network none` or a working network;
> filtering by host from there needs an egress proxy the agent controls, which is
> the natural follow-up. DNS rebinding between the check and the connection is
> also still open — closing it means pinning the checked address.

## Secrets

- API keys and credentials are stored outside of model-visible context (env vars / secret store), injected only at the point a tool executes, and redacted from logs.
- The model never sees raw API keys, even for tools that use them internally.

> **Status:** implemented for the credentials the CLI resolves. `resolveCredential`
> in `packages/providers` reads each key from `<NAME>` or a `<NAME>_FILE` naming a
> secret file, rejects one carrying whitespace or control characters, and reports
> failures by variable name rather than by value; `createRedactingLogger` filters
> the resolved values back out of everything the agent loop logs, and `redactUrl`
> covers the keys providers take as a query parameter. A pluggable secret store
> (OS keychain, Vault) is a design target, not code.
>
> Secrets on disk are covered separately by the file policy in
> `packages/tools-files` (#59): `.env`, private keys, `.ssh/**`, `.aws/credentials`
> and similar are refused for reads and writes and hidden from listings and
> search results, with `deny`/`allow` overrides per deployment. It binds the file
> tools only. `run_command` is no longer the hole it was — under a sandbox it
> sees a read-only filesystem and only the workspace is writable — but a
> secret _inside_ the workspace is still readable by a command, since the
> file policy is enforced by the file tools rather than by the kernel.

## Prompt-injection defenses

- Content fetched from the web/files/tool output is tagged as untrusted data in context and instructed (via system prompt + guardrails) not to be treated as instructions.
- Tool calls triggered as a direct consequence of untrusted content should be held to the same `ask`/`dangerous` thresholds as user-initiated ones — untrusted content cannot itself elevate permissions.
- Dangerous-action detection: a lightweight classifier/heuristic layer can flag suspicious tool-call sequences (e.g. "read email → then send email to new external address") for extra scrutiny even if individual steps are `safe`.

## Audit logs

Every tool invocation is logged with: timestamp, profile, tool name, arguments, permission level, approval decision (if any), and result/error. Logs are stored locally by default and are the user's data.

## Privacy controls

Users can view, export, and delete conversation history, task history, and long-term memory. Memory writes should be inspectable, not silent.
