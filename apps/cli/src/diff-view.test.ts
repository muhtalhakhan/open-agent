import { describe, expect, it } from 'vitest'
import { colorizeDiff, sanitizeForDisplay } from './diff-view.js'

describe('sanitizeForDisplay', () => {
  it('shows an ANSI escape as text, so the terminal never acts on it', () => {
    expect(sanitizeForDisplay('before\u001b[2Kafter')).toBe('before\\x1b[2Kafter')
  })

  it('replaces DEL as well', () => {
    expect(sanitizeForDisplay('a\x7fb')).toBe('a\\x7fb')
  })

  it('leaves tab and newline, which are how a diff is line-structured', () => {
    expect(sanitizeForDisplay('a\tb\nc')).toBe('a\tb\nc')
  })

  it('leaves ordinary text, and text a diff is full of, untouched', () => {
    const patch = '--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-old\n+new'
    expect(sanitizeForDisplay(patch)).toBe(patch)
  })
})

describe('colorizeDiff', () => {
  const patch = ['--- a/notes.txt', '+++ b/notes.txt', '@@ -1,1 +1,1 @@', '-old', '+new'].join('\n')

  it('leaves the file headers plain, rather than painting a path as a change', () => {
    const [oldHeader, newHeader] = colorizeDiff(patch).split('\n')
    expect(oldHeader).toBe('--- a/notes.txt')
    expect(newHeader).toBe('+++ b/notes.txt')
  })

  it('colors additions green, deletions red and the hunk header cyan', () => {
    const colored = colorizeDiff(patch)
    expect(colored).toContain('\u001b[31m-old\u001b[0m')
    expect(colored).toContain('\u001b[32m+new\u001b[0m')
    expect(colored).toContain('\u001b[36m@@ -1,1 +1,1 @@\u001b[0m')
  })
})
