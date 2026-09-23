/**
 * A minimal line-based unified diff for human review (plan mode). Not a patch
 * engine — nothing here can apply a change, it only renders what a `write_file`
 * call would do, so a person can approve or reject it first.
 *
 * Output shape is familiar from `diff -u`, with zero context on paper but a
 * small window of unchanged lines either side of each change to keep edits
 * readable:
 *
 *   --- a/notes.txt
 *   +++ b/notes.txt
 *   @@ -1,2 +1,3 @@
 *    first line
 *   -second line
 *   +second line (edited)
 *   +third line
 *
 * Content is split into lines, so a change to the trailing newline is
 * represented as a change to the final line with the `\ No newline at end of
 * file` marker from unified diff. Two files that are byte-identical produce
 * `''`.
 */

const CONTEXT = 2
/** LCS cells before the whole-file fallback kicks in. ~2000 x 2000 lines. */
const MAX_DIFF_CELLS = 4_000_000
/** Rendered patch lines shown at most; longer output is truncated with a marker. */
const MAX_PATCH_LINES = 4_000

/** The contents of a file as a list of lines, plus whether the file ends in `\n`. */
function splitLines(text: string): { lines: string[]; endsWithNewline: boolean } {
  if (text === '') return { lines: [], endsWithNewline: false }
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
    return { lines, endsWithNewline: true }
  }
  return { lines, endsWithNewline: false }
}

export function makePatch(relativePath: string, before: string, after: string): string {
  if (before === after) return ''

  const a = splitLines(before)
  const b = splitLines(after)
  const ops = editScript(a.lines, b.lines)

  if (ops.every((op) => op.kind === 'equal')) {
    // The only possible byte difference left is the final newline. Turn the
    // last line into a delete+insert of the same text so the hunk (and the
    // no-newline marker) render instead of an invisible one-line change.
    if (a.endsWithNewline === b.endsWithNewline) return ''
    if (ops.length === 0) return ''
    const last = ops[ops.length - 1]
    ops[ops.length - 1] = { kind: 'delete', line: last.line, oldIndex: last.oldIndex, newIndex: null }
    ops.push({ kind: 'insert', line: last.line, oldIndex: null, newIndex: last.newIndex })
  }

  return renderPatch(relativePath, ops, a.endsWithNewline, b.endsWithNewline)
}

type OpKind = 'equal' | 'delete' | 'insert'

interface Op {
  kind: OpKind
  line: string
  /** Index into the original lines; `null` for inserted lines. */
  oldIndex: number | null
  /** Index into the updated lines; `null` for deleted lines. */
  newIndex: number | null
}

/** The edit script turning `a` into `b`: deletions, insertions, equal lines. */
function editScript(a: string[], b: string[]): Op[] {
  if (a.length * b.length > MAX_DIFF_CELLS) {
    // Too big to diff in memory: show the replacement honestly instead.
    const ops: Op[] = []
    a.forEach((line, i) => ops.push({ kind: 'delete', line, oldIndex: i, newIndex: null }))
    b.forEach((line, j) => ops.push({ kind: 'insert', line, oldIndex: null, newIndex: j }))
    return ops
  }
  if (a.length === 0) return b.map<Op>((line, j) => ({ kind: 'insert', line, oldIndex: null, newIndex: j }))
  if (b.length === 0) return a.map<Op>((line, i) => ({ kind: 'delete', line, oldIndex: i, newIndex: null }))

  // LCS lengths over prefixes. `dp[i][j]` is the LCS of a[0..i) and b[0..j);
  // every row is kept so the edit script can be walked back out of it.
  const dp: Uint32Array[] = [new Uint32Array(b.length + 1)]
  for (let i = 1; i <= a.length; i++) {
    const row = new Uint32Array(b.length + 1)
    const previous = dp[i - 1]
    const ai = a[i - 1]
    for (let j = 1; j <= b.length; j++) {
      row[j] = ai === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], row[j - 1])
    }
    dp.push(row)
  }

  const ops: Op[] = []
  let i = a.length
  let j = b.length
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'equal', line: a[i - 1], oldIndex: i - 1, newIndex: j - 1 })
      i--
      j--
    } else if (dp[i][j - 1] >= dp[i - 1][j]) {
      ops.push({ kind: 'insert', line: b[j - 1], oldIndex: null, newIndex: j - 1 })
      j--
    } else {
      ops.push({ kind: 'delete', line: a[i - 1], oldIndex: i - 1, newIndex: null })
      i--
    }
  }
  while (i > 0) {
    ops.push({ kind: 'delete', line: a[i - 1], oldIndex: i - 1, newIndex: null })
    i--
  }
  while (j > 0) {
    ops.push({ kind: 'insert', line: b[j - 1], oldIndex: null, newIndex: j - 1 })
    j--
  }
  return ops.reverse()
}

function renderPatch(relativePath: string, ops: Op[], aEndsWithNewline: boolean, bEndsWithNewline: boolean): string {
  const lines: string[] = [`--- a/${relativePath}`, `+++ b/${relativePath}`]

  // Prefix counts: how many lines of each side appeared before ops[k]. The
  // hunk headers need absolute positions, not positions within the hunk.
  const aPref: number[] = [0]
  const bPref: number[] = [0]
  for (const op of ops) {
    aPref.push(aPref[aPref.length - 1] + (op.oldIndex === null ? 0 : 1))
    bPref.push(bPref[bPref.length - 1] + (op.newIndex === null ? 0 : 1))
  }

  // The final line numbers, for the no-newline markers (-1 when a side is empty).
  const aLast = ops.reduce((last, op) => Math.max(last, op.oldIndex ?? -1), -1)
  const bLast = ops.reduce((last, op) => Math.max(last, op.newIndex ?? -1), -1)

  // Runs of change ops, expanded by CONTEXT equal lines on each side and
  // merged when the expansions would overlap, become hunks.
  const runs: Array<{ start: number; end: number }> = []
  let runStart = -1
  ops.forEach((op, index) => {
    if (op.kind !== 'equal') {
      if (runStart === -1) runStart = index
    } else if (runStart !== -1) {
      runs.push({ start: runStart, end: index - 1 })
      runStart = -1
    }
  })
  if (runStart !== -1) runs.push({ start: runStart, end: ops.length - 1 })

  const hunks: Array<{ start: number; end: number }> = []
  for (const run of runs) {
    const start = Math.max(0, run.start - CONTEXT)
    const end = Math.min(ops.length - 1, run.end + CONTEXT)
    const last = hunks[hunks.length - 1]
    if (last && start <= last.end + 1) last.end = end
    else hunks.push({ start, end })
  }

  for (const hunk of hunks) {
    const aCount = aPref[hunk.end + 1] - aPref[hunk.start]
    const bCount = bPref[hunk.end + 1] - bPref[hunk.start]
    // Zero in the header ("-0,0") is the unified convention for "no lines
    // before the insertion point"; otherwise the count is 1-based.
    const aStart = aCount === 0 ? 0 : aPref[hunk.start] + 1
    const bStart = bCount === 0 ? 0 : bPref[hunk.start] + 1
    const body: string[] = []
    for (let index = hunk.start; index <= hunk.end; index++) {
      const op = ops[index]
      const marker = op.kind === 'delete' ? '-' : op.kind === 'insert' ? '+' : ' '
      body.push(`${marker}${op.line}`)
      // A file whose last line has no newline says so, exactly like unified
      // diff — otherwise "+last" looks like it owns the newline it does not.
      if (op.oldIndex === aLast && !aEndsWithNewline) {
        body.push(`\\ No newline at end of file`)
      }
      if (op.newIndex === bLast && !bEndsWithNewline) {
        body.push(`\\ No newline at end of file`)
      }
    }
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`)
    lines.push(...body)
  }

  if (lines.length > MAX_PATCH_LINES) {
    lines.length = MAX_PATCH_LINES
    lines.push(`… truncated at ${MAX_PATCH_LINES} lines`)
  }
  return lines.join('\n')
}
