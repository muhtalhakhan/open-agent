/**
 * Renders the Markdown a model answers in as styled terminal text: headings,
 * emphasis, lists, quotes, code and tables, the way a reader would see them
 * rendered anywhere else, instead of as a page of `**` and `#`.
 *
 * Deliberately small and line-oriented. A model's answer is not an arbitrary
 * CommonMark document, and a full parser plus its dependency tree is a lot to
 * carry for headings and bullet points. Anything this does not recognise is
 * printed as written, which is the right failure for a terminal: never lose
 * text, at worst leave a stray `*`.
 */

const ESC = '\x1b['
const style = (open: number, close: number) => (text: string) => `${ESC}${open}m${text}${ESC}${close}m`

const bold = style(1, 22)
const dim = style(2, 22)
const italic = style(3, 23)
const underline = style(4, 24)
const strike = style(9, 29)
const cyan = style(36, 39)
const magenta = style(35, 39)

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g

/** Printed width, ignoring the escape codes that styling adds. */
function visibleLength(text: string): number {
  return [...text.replace(ANSI, '')].length
}

/**
 * Inline styling: code, links, bold, italic, strikethrough. Underscore
 * emphasis needs a non-word character on both sides, so `snake_case_names`
 * survive intact.
 */
export function renderInline(text: string): string {
  const stash = new Stash()
  // Code spans and links are set aside before any emphasis is looked for:
  // `a*b*c` in backticks is code, and a URL is full of `_` and `*` that are
  // not emphasis.
  let out = text
    .replace(/`([^`\n]+)`/g, (_, code: string) => stash.put(cyan(code)))
    .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_, ch: string) => stash.put(ch))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) =>
      stash.put(label === url ? underline(url) : `${underline(label)} ${dim(`(${url})`)}`),
    )

  out = out
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, (_, inner: string) => bold(inner))
    .replace(/(^|\W)__(?=\S)(.+?)(?<=\S)__(?=\W|$)/g, (_, pre: string, inner: string) => pre + bold(inner))
    .replace(/(^|[^*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?!\*)/g, (_, pre: string, inner: string) => pre + italic(inner))
    .replace(/(^|\W)_(?=\S)(.+?)(?<=\S)_(?=\W|$)/g, (_, pre: string, inner: string) => pre + italic(inner))
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_, inner: string) => strike(inner))

  return stash.restore(out)
}

/**
 * Holds text aside behind a placeholder no pattern here can match. The
 * placeholder is built from private-use code points, which a model's answer
 * has no reason to contain.
 */
class Stash {
  private static readonly open = String.fromCharCode(0xe000)
  private static readonly close = String.fromCharCode(0xe001)
  private readonly held: string[] = []

  put(text: string): string {
    return `${Stash.open}${this.held.push(text) - 1}${Stash.close}`
  }

  /**
   * Puts everything back. Repeats until nothing is left to restore, because
   * stashed text can hold placeholders of its own — a link whose label has
   * code in it is stashed after the code was.
   */
  restore(text: string): string {
    const placeholder = new RegExp(`${Stash.open}(\\d+)${Stash.close}`, 'g')
    let out = text
    for (let depth = 0; depth <= this.held.length && placeholder.test(out); depth++) {
      out = out.replace(placeholder, (_, i: string) => this.held[Number(i)])
    }
    return out
  }
}

// The info string after the fence is a language and then anything at all —
// `ts title="a.ts"`, `js {1,3}` — of which only the language is shown.
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)[^`]*$/
// A closing run of `#` only counts after a space, so `## Using C#` keeps it.
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const BULLET = /^(\s*)[-*+]\s+(\[[ xX]\]\s+)?(.*)$/
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())
}

/** Pads every column to its widest cell, header in bold, with a rule beneath it. */
function renderTable(rows: string[]): string[] {
  const [header, , ...body] = rows.map(splitRow)
  const cells = [header, ...body].map((row) => row.map(renderInline))
  const columns = Math.max(...cells.map((row) => row.length))
  const widths = Array.from({ length: columns }, (_, c) => Math.max(...cells.map((row) => visibleLength(row[c] ?? ''))))
  const line = (row: string[]) =>
    row
      .concat(Array(columns - row.length).fill(''))
      .map((cell, c) => cell + ' '.repeat(widths[c] - visibleLength(cell)))
      .join('  ')
      .trimEnd()

  return [
    line(cells[0].map((cell) => bold(cell))),
    dim(widths.map((w) => '─'.repeat(w)).join('  ')),
    ...cells.slice(1).map(line),
  ]
}

/** Renders a whole answer. */
export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = FENCE.exec(line)
    if (fence) {
      // Everything up to the matching fence is code, printed verbatim. An
      // unclosed fence runs to the end, as it would in any renderer.
      const marker = fence[1]
      const code: string[] = []
      while (++i < lines.length && !lines[i].trim().startsWith(marker)) code.push(lines[i])
      if (fence[2]) out.push(dim(`  ${fence[2]}`))
      out.push(...code.map((codeLine) => `  ${cyan(codeLine)}`))
      continue
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const rows = [line, lines[i + 1]]
      i += 2
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(lines[i++])
      i--
      out.push(...renderTable(rows))
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const text = renderInline(heading[2])
      out.push(heading[1].length === 1 ? bold(underline(magenta(text))) : bold(magenta(text)))
      continue
    }

    if (RULE.test(line)) {
      out.push(dim('─'.repeat(40)))
      continue
    }

    const bullet = BULLET.exec(line)
    if (bullet) {
      const [, indent, checkbox, text] = bullet
      const mark = checkbox ? (/x/i.test(checkbox) ? '☑' : '☐') : '•'
      out.push(`${indent}${mark} ${renderInline(text)}`)
      continue
    }

    const ordered = ORDERED.exec(line)
    if (ordered) {
      out.push(`${ordered[1]}${ordered[2]}. ${renderInline(ordered[3])}`)
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      out.push(`${dim('│')} ${italic(renderInline(quote[1]))}`)
      continue
    }

    out.push(renderInline(line))
  }
  return out.join('\n')
}

/**
 * Whether answers should be rendered: only for a person at a terminal who
 * has not asked for plain output. Piped output keeps the Markdown as written,
 * because whatever reads it will want the source, not escape codes.
 */
export function shouldRenderMarkdown(isTTY: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  return Boolean(isTTY) && !env.NO_COLOR && env.TERM !== 'dumb'
}
