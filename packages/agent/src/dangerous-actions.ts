import type { ToolCall } from './types.js'
import { isPrivateHost } from './network-policy.js'

/**
 * Sequence-level scrutiny for tool calls that are individually unremarkable.
 *
 * The permission levels judge one call at a time: `read_file` is `safe`
 * because reading a file the user pointed at is safe, and it stays `safe`
 * however many times it is called. But "read the invoice, then POST it
 * somewhere the user never mentioned" is two ordinary steps that together are
 * the thing the permission system exists to prevent. Neither step can be
 * raised to `ask` without making the tool useless for its honest use, so the
 * judgement has to be about the pair, not about either half.
 *
 * So this layer watches what a task has read and where it is now sending it,
 * and escalates a call that carries data to a destination nobody asked for.
 * It does not block anything by itself — it turns a call that would have run
 * silently into one the user is asked about, which is the "extra scrutiny"
 * docs/security-model.md asks for.
 *
 * Heuristics are wrong sometimes, and this one errs towards asking. That is
 * the tolerable direction: a needless prompt costs a keystroke, and the case
 * it is wrong about in the other direction is the whole point.
 */

/** A rule's verdict on a call, carried to the approval handler so the user learns why. */
export interface Escalation {
  /** Stable identifier for the rule, for logs and tests. */
  rule: string
  /** One line, addressed to the person answering the prompt. */
  reason: string
}

/** What a task has done so far, as far as the rules care. */
export interface TaskActivity {
  /** Tools whose content this task has read back. Empty until the first result. */
  ingested: Set<string>
  /**
   * Destinations that need no explanation: named by the user, or already
   * reached earlier in this task. Hosts, lowercased and stripped of `www.`.
   */
  known: Set<string>
}

export function newTaskActivity(): TaskActivity {
  return { ingested: new Set(), known: new Set() }
}

/** Matches an absolute http(s) URL inside free text or an argument value. */
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]},]+/gi

/**
 * Matches an email address. The domain is the destination — a message to
 * `attacker@evil.test` leaves for `evil.test` whatever the local part is.
 */
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@([A-Z0-9-]+(?:\.[A-Z0-9-]+)+)/gi

/**
 * `www.` is noise: a user who says "example.com" has named the same place the
 * model writes as `https://www.example.com/`, and treating them as two
 * destinations would prompt about the one the user just asked for.
 */
function normalizeHost(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host.startsWith('www.') ? host.slice(4) : host
}

/**
 * Every destination named in a piece of text, as hosts.
 *
 * Deliberately pattern-based rather than schema-based. The rule has to work
 * for a tool it has never heard of — an MCP server's `send_email` with a `to`
 * field, a webhook tool with an `endpoint` — and the one thing those have in
 * common is that the destination is written down somewhere in the arguments.
 * Keying on names like `url` or `to` alone would miss every tool that spells
 * it differently, which is most of them; `DESTINATION_FIELDS` adds those
 * names on top, for the one case a pattern cannot settle.
 */
export function destinationsInText(text: string): Set<string> {
  const found = new Set<string>()
  for (const match of text.matchAll(URL_PATTERN)) {
    try {
      found.add(normalizeHost(new URL(match[0]).hostname))
    } catch {
      // Not a URL after all; the pattern is deliberately loose.
    }
  }
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    found.add(normalizeHost(match[1]))
  }
  return found
}

/** Whether a string is one destination and nothing else — an address, not prose carrying one. */
function isSingleDestination(trimmed: string): boolean {
  if (/\s/.test(trimmed)) return false
  const urls = [...trimmed.matchAll(URL_PATTERN)]
  if (urls.length === 1 && urls[0][0] === trimmed) return true
  const emails = [...trimmed.matchAll(EMAIL_PATTERN)]
  return emails.length === 1 && emails[0][0] === trimmed
}

/** How deep into nested arguments to look before giving up. */
const MAX_DEPTH = 6

/**
 * Longest string still read as naming a destination rather than carrying one.
 *
 * Above it, only a string that is *entirely* one destination counts. The
 * difference is address versus payload: `{"to": "Alice <a@evil.test>"}` is
 * where the call is going, while a fetched page saved to disk merely mentions
 * every link on it. Scanning the payload would flag "save this page to
 * notes.md" as exfiltration to whoever the page happened to link to — and,
 * worse, suppress the user's remembered approval for `write_file` whenever the
 * text contained a URL.
 *
 * The length test alone would miss a long URL, which is exactly how data
 * leaves in a query string, so an oversized value that is nothing but a URL is
 * still read as one.
 */
const MAX_ADDRESS_LENGTH = 256

/**
 * Argument names that mean "where this is going".
 *
 * Needed because a bare hostname cannot be recognised by shape alone: the
 * last label of `notes.md` is a real country-code TLD, as are `.sh`, `.py`,
 * `.rs` and most other file extensions worth worrying about. No syntax rule
 * separates a filename from a hostname, so the field's own name is the only
 * evidence there is.
 *
 * This is a supplement, not the mechanism. URLs and email addresses are still
 * found in any field whatever it is called, so a tool nobody has heard of is
 * still covered; naming a field only buys the bare-hostname case on top.
 */
const DESTINATION_FIELDS = new Set([
  'address',
  'callback',
  'domain',
  'endpoint',
  'host',
  'hostname',
  'origin',
  'recipient',
  'recipients',
  'server',
  'site',
  'target',
  'to',
  'uri',
  'url',
  'webhook',
])

/** Four numeric labels in range — an address, where a version number is not. */
function isIpv4(candidate: string): boolean {
  const parts = candidate.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * A bare hostname, for a field that has said it holds one.
 *
 * Tolerates a port and a path so `evil.test:8080/collect` still names its
 * host. A last label that is not alphabetic rules out a version number like
 * `1.2.3`, while a genuine IPv4 address is kept.
 */
function bareHost(value: string): string | undefined {
  const candidate = value.trim().split(/[/?#]/)[0].split(':')[0]
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(candidate)) return undefined
  const lastLabel = candidate.slice(candidate.lastIndexOf('.') + 1)
  if (!/^[a-z]{2,}$/i.test(lastLabel) && !isIpv4(candidate)) return undefined
  return normalizeHost(candidate)
}

/** Every destination a call is addressed to, as named in its arguments. */
export function destinationsIn(args: Record<string, unknown>): Set<string> {
  const found = new Set<string>()
  const walk = (value: unknown, depth: number, field?: string): void => {
    if (depth > MAX_DEPTH) return
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length > MAX_ADDRESS_LENGTH && !isSingleDestination(trimmed)) return
      for (const host of destinationsInText(trimmed)) found.add(host)
      if (field !== undefined && DESTINATION_FIELDS.has(field.toLowerCase())) {
        const host = bareHost(trimmed)
        if (host !== undefined) found.add(host)
      }
      return
    }
    if (Array.isArray(value)) {
      // The field name carries into a list, so `recipients: [...]` still names
      // every one of them.
      for (const item of value) walk(item, depth + 1, field)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, depth + 1, key)
    }
  }
  walk(args, 0)
  return found
}

/**
 * The one rule: data went in, and now something is going out somewhere new.
 *
 * Both halves matter. Without the ingest check every first request to a fresh
 * host would prompt, including the one the task exists to make. Without the
 * destination check the rule would fire on the task re-reading the same API it
 * has used all along. It is the combination — this task has read something,
 * and is now addressing a place neither the user nor the task has mentioned —
 * that distinguishes "fetch the docs I asked for" from "mail the docs to
 * someone the page chose".
 *
 * Private and loopback hosts are not exfiltration and are skipped;
 * `NetworkPolicy` is what guards those, and it refuses them by default.
 */
export function detectExfiltration(call: ToolCall, activity: TaskActivity): Escalation | undefined {
  if (activity.ingested.size === 0) return undefined

  const novel = [...destinationsIn(call.args)].filter((host) => !activity.known.has(host) && !isPrivateHost(host))
  if (novel.length === 0) return undefined

  const sources = [...activity.ingested].sort().join(', ')
  return {
    rule: 'exfiltration-after-ingest',
    reason:
      `"${call.name}" is addressing ${novel.sort().join(', ')}, which neither you nor this task has mentioned, ` +
      `after the task read content from ${sources}. Approve only if sending that data there is what you asked for.`,
  }
}
