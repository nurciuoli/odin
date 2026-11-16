export interface CsvRow {
  /** One-based logical record and physical starting line in the original file. */
  record: number
  line: number
  values: string[]
}

export interface CsvSelection {
  rows: CsvRow[]
  delimiter: string
}

export const CSV_ROW_LIMIT = 10_000
export const CSV_COLUMN_LIMIT = 200

export function parseCsv(source: string, delimiter: string, rowLimit = CSV_ROW_LIMIT) {
  const text = source.replace(/^\uFEFF/, '')
  const rows: CsvRow[] = []
  const errors: string[] = []
  let values: string[] = []
  let field = ''
  let quoted = false
  let closed = false
  let line = 1
  let startLine = 1
  let columnCount = 0
  let truncatedColumns = false
  let truncated = false
  const error = (message: string) => {
    if (errors.length < 5) errors.push(`Line ${line}: ${message}`)
  }
  const cell = () => {
    columnCount++
    if (values.length < CSV_COLUMN_LIMIT) values.push(field)
    else truncatedColumns = true
    field = ''
    closed = false
  }
  const record = () => {
    cell()
    rows.push({ record: rows.length + 1, line: startLine, values })
    values = []
    columnCount = 0
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
          closed = true
        }
      } else {
        field += char
        if (char === '\n' || (char === '\r' && text[i + 1] !== '\n')) line++
      }
      continue
    }
    if (char === delimiter) cell()
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++
      record()
      line++
      startLine = line
      if (rows.length >= rowLimit && i < text.length - 1) {
        truncated = true
        break
      }
    } else if (char === '"' && field === '' && !closed) quoted = true
    else {
      if (char === '"' || closed) error('Unexpected character in an unquoted or closed field.')
      closed = false
      field += char
    }
  }
  if (quoted) error('Unclosed quoted field; the remaining text is shown in one cell.')
  if (!truncated && (field !== '' || columnCount > 0 || quoted || closed)) record()
  return { rows, errors, truncated, truncatedColumns }
}

export function detectDelimiter(source: string, filename = ''): string {
  const candidates = filename.toLowerCase().endsWith('.tsv')
    ? ['\t', ',', ';', '|']
    : [',', '\t', ';', '|']
  let best = candidates[0]!
  let bestScore = 0
  for (const delimiter of candidates) {
    const { rows } = parseCsv(source, delimiter, 30)
    const counts = new Map<number, number>()
    for (const row of rows) {
      if (row.values.length > 1)
        counts.set(row.values.length, (counts.get(row.values.length) ?? 0) + 1)
    }
    for (const [width, count] of counts) {
      const score = (count / Math.max(rows.length, 1)) * 100 + Math.min(width, 20)
      if (score > bestScore) {
        bestScore = score
        best = delimiter
      }
    }
  }
  return best
}
