// Fuzzy matching for the command palette: every space-separated word of the query must appear in the text as an
// in-order subsequence. Consecutive runs, word starts and a prefix score higher; `indices` are the matched characters
// (for highlighting). Case-insensitive. Pure, so it is tested without the DOM.

export interface FuzzyMatch {
  score: number
  /** Positions in the text, ascending, that the query matched. */
  indices: number[]
}

const isBoundary = (text: string, i: number) => {
  if (i === 0) return true
  const prev = text[i - 1]!
  const cur = text[i]!
  return (
    /[\s/\\._\-:]/.test(prev) ||
    (prev === prev.toLowerCase() && prev !== prev.toUpperCase() && cur !== cur.toLowerCase())
  )
}

/** Best match of one word: the earliest start that gives the best run, greedily extended. */
function matchWord(text: string, lower: string, word: string, from: number): FuzzyMatch | null {
  let best: FuzzyMatch | null = null
  for (
    let start = lower.indexOf(word[0]!, from);
    start !== -1;
    start = lower.indexOf(word[0]!, start + 1)
  ) {
    const indices = [start]
    let pos = start
    let ok = true
    for (let k = 1; k < word.length; k++) {
      // prefer the next character straight after the previous one, else the next boundary, else the next occurrence
      if (lower[pos + 1] === word[k]) pos += 1
      else {
        let next = lower.indexOf(word[k]!, pos + 1)
        for (let j = next; j !== -1; j = lower.indexOf(word[k]!, j + 1)) {
          if (isBoundary(text, j)) {
            next = j
            break
          }
        }
        if (next === -1) {
          ok = false
          break
        }
        pos = next
      }
      indices.push(pos)
    }
    if (!ok) break // a later start can only fail too
    // too scattered to be what you meant, unless every letter opens a word (an acronym: "fft" → Fix flaky tests)
    const span = indices[indices.length - 1]! - start + 1
    if (span > word.length * 2 + 3 && !indices.every(i => isBoundary(text, i))) continue
    let score = 0
    for (let k = 0; k < indices.length; k++) {
      score += 1
      if (k > 0 && indices[k] === indices[k - 1]! + 1) score += 4
      if (isBoundary(text, indices[k]!)) score += 3
    }
    if (start === 0) score += 6
    score -= (indices[indices.length - 1]! - start - (word.length - 1)) * 0.25 // gaps
    score -= start * 0.05 // later starts
    if (!best || score > best.score) best = { score, indices }
  }
  return best
}

export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return { score: 0, indices: [] }
  const lower = text.toLowerCase()
  let score = 0
  const all = new Set<number>()
  for (const word of words) {
    const m = matchWord(text, lower, word, 0)
    if (!m) return null
    score += m.score
    m.indices.forEach(i => all.add(i))
  }
  // a shorter text that matches is the tighter hit
  score -= text.length * 0.02
  return { score, indices: [...all].sort((a, b) => a - b) }
}

/** The matches of `query` over `items`, best first. Ties keep the input order. */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
): { item: T; match: FuzzyMatch }[] {
  return items
    .map((item, order) => ({ item, order, match: fuzzyMatch(text(item), query) }))
    .filter((r): r is { item: T; order: number; match: FuzzyMatch } => r.match !== null)
    .sort((a, b) => b.match.score - a.match.score || a.order - b.order)
    .map(({ item, match }) => ({ item, match }))
}
