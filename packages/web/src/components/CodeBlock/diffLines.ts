import type { DiffHunk, DiffLine } from './Diff.vue'

const splitLines = (text: string): string[] => {
  if (text === '') return []
  const lines = text.split('\n')
  // a trailing newline ends the last line, it does not start another
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Line diff of two texts (longest common subsequence) as hunks for IuDiff. Everything lands in one hunk
 * with context lines for the unchanged parts; identical or empty input gives no add/remove lines, and two
 * empty texts give no hunks.
 */
export function diffLines(before: string, after: string): DiffHunk[] {
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length === 0 && b.length === 0) return []

  // lcs[i][j]: length of the common subsequence of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ type: 'context', oldNum: i + 1, newNum: j + 1, content: a[i]! })
      i++
      j++
    } else if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      lines.push({ type: 'remove', oldNum: i + 1, content: a[i]! })
      i++
    } else {
      lines.push({ type: 'add', newNum: j + 1, content: b[j]! })
      j++
    }
  }
  return [{ lines }]
}
