# @open-agent/tools-http

One tool, `http_request`: a direct HTTP call to an arbitrary REST/HTTP API — method, URL, headers and body in; status, headers and body out.

This is deliberately **not** the structured-integration path. MCP servers (`@open-agent/tools-mcp`) and the managed integration catalog are for services with a real, typed tool surface. `http_request` is the fallback for the long tail: an internal service, a one-off endpoint, an API that nobody has written an MCP server for.

## Usage

```ts
import { ToolRegistry } from '@open-agent/agent'
import { httpRequestTool } from '@open-agent/tools-http'

const tools = new ToolRegistry()
tools.register(
  httpRequestTool({
    allowedHosts: ['api.github.com'],
    secrets: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! },
  }),
)
```

The model then calls it with the credential as a placeholder:

```json
{ "url": "https://api.github.com/user/repos", "headers": { "authorization": "Bearer {{GITHUB_TOKEN}}" } }
```

In the CLI, set `HTTP_TOOL=1` (plus `HTTP_ALLOWED_HOSTS` and any `HTTP_SECRET_<NAME>`) — see `.env.example`.

## Permission level

`ask`, always, and not configurable. The point of the tool is reaching a service the runtime knows nothing about, so neither the effect of a request (a `POST` that charges a card) nor its destination can be judged ahead of time. `allowedHosts` narrows where it can go; it does not make a call safe to run unattended. See `docs/security-model.md`.

## Guard rails

- **Host allowlist** (`allowedHosts`) — the local stand-in until per-profile network restrictions land. `example.com` matches `example.com` and its subdomains; omit the option for no restriction, pass `[]` to allow nothing. Only `http:` and `https:` URLs are accepted, so the tool can't be turned into a `file:` reader.
- **Secret placeholders** (`secrets`) — the model writes `{{NAME}}`, the value is substituted at send time and put back as `{{NAME}}` in everything the tool returns. The key never enters the transcript, the audit log, or an error message; an unknown name fails the call rather than sending a blank credential.
- **Response ceiling** (`maxResponseBytes`, default 64000) — the body is streamed and the connection dropped once the ceiling is hit, so a huge or endless response can't evict the rest of the conversation. Truncation is marked in the output. A non-textual body (an image, an octet-stream) is reported by content type and size rather than pasted in.
- **Timeout** (`timeoutMs`, default 30000), and the caller's `AbortSignal` is honoured throughout.

A 4xx/5xx comes back as `ok: false` with `error: "HTTP <status>"`, but the body is still handed to the model — the error payload is usually the most useful thing an API returns.

## Network restrictions

`allowedHosts` narrows where the tool may go, `deniedHosts` refuses hosts outright, and both are checked on the first URL _and_ on every redirect hop.

The default worth knowing about is the one you do not configure: **loopback, private and link-local addresses are refused** even with no allowlist set. An agent's URLs frequently come from a page it just read, so "the attacker picks the URL" is the ordinary case — and `http://169.254.169.254/latest/meta-data/iam/security-credentials/` returns cloud credentials to anything that asks. `http://localhost:6379` and the rest of what is listening on the host are the same problem in a smaller hat.

Reaching a local API is a legitimate thing to want, so either name the host (`allowedHosts: ['localhost']`, which is a decision about that host) or set `allowLocal: true` (which is a decision about all of them). In the CLI: `HTTP_ALLOWED_HOSTS`, `HTTP_DENIED_HOSTS`, `HTTP_ALLOW_LOCAL`.

Two further protections, and their limits:

- **Redirects are followed manually**, each hop re-vetted. Following automatically would let one `302` to a private address undo the check the first URL passed.
- **The hostname is checked against what it resolves to**, because `metadata.evil.test A 169.254.169.254` costs an attacker one DNS record. This narrows the hole rather than closing it: a name re-resolved between the check and the connection can still change. Closing that means pinning the checked address, which is not done here.
