// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { detectDelimiter, parseCsv } from './csv'
describe('CSV parsing', () => {
  it('preserves identifiers, empty cells and multiline quoted records with original lines', () => {
    const parsed = parseCsv('\uFEFFid,note,empty\r\n00123,"first\r\nsecond",\r\n9,"a""b",x', ',')
    expect(parsed.errors).toEqual([])
    expect(parsed.rows[1]).toEqual({ record: 2, line: 2, values: ['00123', 'first\r\nsecond', ''] })
    expect(parsed.rows[2]?.line).toBe(4)
    expect(parsed.rows[2]?.values[1]).toBe('a"b')
  })
  it('detects semicolons without confusing quoted commas', () => {
    expect(detectDelimiter('id;note\n1;"a,b"\n2;c')).toBe(';')
  })
  it('labels partial parsing and reports malformed quotes', () => {
    expect(parseCsv('a\nb\nc', ',', 2).truncated).toBe(true)
    expect(parseCsv('a,"broken', ',').errors[0]).toContain('Unclosed')
  })
})
