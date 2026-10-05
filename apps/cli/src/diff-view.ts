const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const CYAN = '\u001b[36m'
const RESET = '\u001b[0m'

/** Control characters a terminal would act on: below 0x20 except tab and newline, plus DEL. */
// eslint-disable-next-line no-control-regex -- matching them is the point
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

/**
 * Shows control characters as escapes rather than letting the terminal act on
 * them.
 *
 * The diff rendered in a plan-mode prompt is file content, and that content
 * may be something the model copied out of a page it read. An escape sequence
 * in it would repaint the screen, so the diff on screen would no longer be the
 * diff that gets written — and the prompt is a security boundary, which makes
 * that worth closing rather than noting.
 *
 * Newline and tab are left alone: they are how a diff is line-structured, and
 * neither moves the cursor on its own.
 */
export function sanitizeForDisplay(text: string): string {
  return text.replace(CONTROL, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/**
 * Colorizes a diff patch for direct terminal output: additions green,
 * deletions red, hunk headers cyan. Plain text is passed through untouched,
 * so a diff with no color at all renders correctly wherever it lands.
 */
export function colorizeDiff(patch: string): string {
  return patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('@@')) return `${CYAN}${line}${RESET}`
      // Ahead of the `+`/`-` cases below, which would read a file header as a
      // changed line and paint the path as if the edit had renamed the file.
      if (line.startsWith('--- ') || line.startsWith('+++ ')) return line
      if (line.startsWith('+')) return `${GREEN}${line}${RESET}`
      if (line.startsWith('-')) return `${RED}${line}${RESET}`
      return line
    })
    .join('\n')
}
