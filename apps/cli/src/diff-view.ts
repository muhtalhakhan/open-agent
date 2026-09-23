const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const CYAN = '\u001b[36m'
const RESET = '\u001b[0m'

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
      if (line.startsWith('+')) return `${GREEN}${line}${RESET}`
      if (line.startsWith('-')) return `${RED}${line}${RESET}`
      return line
    })
    .join('\n')
}
