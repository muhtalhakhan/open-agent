import cliTruncate from 'cli-truncate'
import stringWidth from 'string-width'

/** Screen rows a line takes once the terminal wraps it. An empty line still takes one. */
function rowsFor(line: string, cols: number): number {
  return Math.max(1, Math.ceil(stringWidth(line) / cols))
}

/**
 * Only the end of a long reply is painted live. Ink repaints its dynamic area
 * by erasing it, and one taller than the terminal cannot be erased — it would
 * leave a smear of copies in the scrollback. The whole reply still lands in
 * the transcript once it is finished.
 *
 * Height is counted in screen rows, not `\n`s: a long line wraps onto several.
 * Widths come from `string-width`, because the live reply is rendered markdown
 * and `.length` would count its ANSI codes and miscount wide characters. Lines
 * are kept whole so they wrap normally; only a single line taller than the
 * space left is cut, from its start, by `cli-truncate`, which keeps the
 * escape codes intact.
 */
export function tail(text: string, rows: number, cols: number): string {
  const lines = text.split('\n')
  if (lines.reduce((sum, line) => sum + rowsFor(line, cols), 0) <= rows) return text

  // One row goes to the `…` marking the cut.
  const budget = rows - 1
  const kept: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const needed = rowsFor(lines[i], cols)
    if (used + needed > budget) {
      if (kept.length === 0) kept.unshift(cliTruncate(lines[i], budget * cols, { position: 'start' }))
      break
    }
    kept.unshift(lines[i])
    used += needed
  }
  return ['…', ...kept].join('\n')
}
