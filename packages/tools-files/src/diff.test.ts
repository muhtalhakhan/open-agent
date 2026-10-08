import { describe, expect, it } from 'vitest'
import { makePatch } from './diff.js'

describe('makePatch', () => {
  it('returns an empty patch for identical content', () => {
    expect(makePatch('f.txt', 'a\nb\n', 'a\nb\n')).toBe('')
  })

  it('shows an empty file becoming a file', () => {
    const patch = makePatch('new.txt', '', 'one\ntwo\n')
    expect(patch).toContain('--- a/new.txt')
    expect(patch).toContain('+++ b/new.txt')
    expect(patch).toContain('@@ -0,0 +1,2 @@')
    expect(patch).toContain('+one')
    expect(patch).toContain('+two')
  })

  it('shows a file becoming empty', () => {
    const patch = makePatch('f.txt', 'one\ntwo\n', '')
    expect(patch).toContain('@@ -1,2 +0,0 @@')
    expect(patch).toContain('-one')
    expect(patch).toContain('-two')
  })

  it('diffs a single changed line with context around it', () => {
    const before = 'a\nb\nc\n'
    const after = 'a\nB\nc\n'
    const patch = makePatch('f.txt', before, after)
    expect(patch).toContain('@@ -1,3 +1,3 @@')
    expect(patch).toContain('-b')
    expect(patch).toContain('+B')
    // Context lines on either side of the change.
    expect(patch).toContain(' a')
    expect(patch).toContain(' c')
  })

  it('marks lines at the end of the file rather than skipping them', () => {
    const before = 'a\nb\n'
    const after = 'a\nb\nc\n'
    const patch = makePatch('f.txt', before, after)
    expect(patch).toContain('@@ -1,2 +1,3 @@')
    expect(patch).toContain('+c')
  })

  it('merges nearby changes into one hunk', () => {
    const before = '1\n2\n3\n4\n5\n6\n7\n8\n'
    const after = '1\n2\nX\n4\n5\n6\nY\n8\n'
    const patch = makePatch('f.txt', before, after)
    expect(patch.match(/^@@ /gm)).toHaveLength(1)
    expect(patch).toContain('@@ -1,8 +1,8 @@')
    expect(patch).toContain('-3')
    expect(patch).toContain('+X')
    expect(patch).toContain('-7')
    expect(patch).toContain('+Y')
  })

  it('keeps distant changes as separate hunks', () => {
    const before = '0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n'
    const after = '0\nX\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\nY\n'
    const patch = makePatch('f.txt', before, after)
    expect(patch.match(/^@@ /gm)).toHaveLength(2)
  })

  it('numbers later hunks from the correct absolute line', () => {
    const before = 'a1\na2\na3\na4\na5\na6\na7\na8\na9\na10\na11\na12\na13\na14\na15\n'
    const after = 'a1\na2\na3\na4\na5\nB6\na7\na8\na9\na10\na11\na12\na13\na14\na15\nX15\n'
    const patch = makePatch('f.txt', before, after)
    // First hunk edits line 6 (lines 4-8 around it); second hunk appends line
    // X15 after the old final line a15, so it is numbered off the old tail.
    expect(patch).toContain('@@ -4,5 +4,5 @@')
    expect(patch).toContain('+B6')
    expect(patch).toContain('@@ -14,2 +14,3 @@')
    expect(patch).toContain('+X15')
  })

  it('marks a removed trailing newline instead of hiding it', () => {
    const patch = makePatch('f.txt', 'a\n', 'a')
    expect(patch).not.toBe('')
    expect(patch).toContain('\\ No newline at end of file')
  })

  it('marks an added trailing newline instead of hiding it', () => {
    const patch = makePatch('f.txt', 'a', 'a\n')
    expect(patch).not.toBe('')
    expect(patch).toContain('\\ No newline at end of file')
  })
})
