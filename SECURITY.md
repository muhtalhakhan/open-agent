# Security Policy

OpenAgent grants an AI agent the ability to browse the web, control a computer, execute shell commands, and read/write files. This is a large attack surface, and security is treated as a core design constraint, not an afterthought.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities. Instead:

- Use GitHub's [private vulnerability reporting](../../security/advisories/new) for this repository, or
- Email talhakhan325.work@gmail.com with details.

Include:

- A description of the vulnerability and its impact
- Steps to reproduce (or a PoC)
- Affected version/commit

We aim to acknowledge reports within 72 hours.

## Design principles

- **Least privilege by default.** Agent profiles must opt in to sensitive capabilities (shell, filesystem outside the workspace, sending messages/emails, etc.) rather than getting them by default.
- **Human approval for risky actions.** Destructive or irreversible actions (payments, deleting files, sending communications, running arbitrary shell commands) should be gated behind an approval step unless the user has explicitly pre-authorized that action class.
- **Sandboxing.** Shell execution and browser automation should run in isolated environments (containers/VMs) wherever possible, not directly on the host.
- **Auditability.** Every tool invocation should be logged with enough context to reconstruct what the agent did and why.
- **Prompt-injection awareness.** Content fetched from the web, files, or tool output is untrusted input and must not be able to silently escalate the agent's permissions or trigger unapproved actions.
- **Secrets isolation.** API keys and credentials are never exposed to model context or logs.

See [docs/security-model.md](docs/security-model.md) for the fuller threat model and design.

## Supported versions

OpenAgent is pre-1.0 and does not yet have a formal support/backport policy. Security fixes land on `main`.
