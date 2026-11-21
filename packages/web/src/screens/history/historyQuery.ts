// History's filter state as plain data: URL query ↔ FilterBar clauses, and which sessions a state lets through.
// URL shape: `?q=slow&archived=1&f=state:is:failed,idle&f=updated:inLast:7 days` (key:op:value, values comma-joined).
import type { Session } from '@odin/shared/api'
import { lastRunAt } from '@odin/shared/session'
import type { Clause, FieldDef, Op } from '@/components/FilterBar'
import { SESSION_DISPLAY } from '@/screens/shared/format'

export interface HistoryState {
  q: string
  clauses: Clause[]
  archived: boolean
}

type Query = Record<string, string | null | (string | null)[] | undefined>

const OPS = new Set<Op>([
  'is',
  'isNot',
  'contains',
  'before',
  'after',
  'gt',
  'lt',
  'between',
  'empty',
  'inLast',
])
const KEYS = new Set(['project', 'state', 'tag', 'model', 'origin', 'lastRun', 'updated'])
const UNITS: Record<string, number> = { hours: 3_600_000, days: 86_400_000, weeks: 7 * 86_400_000 }

const asList = (v: Query[string]): string[] =>
  (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x !== '')

function parseValue(op: Op, raw: string): unknown {
  switch (op) {
    case 'empty':
      return true
    case 'inLast': {
      const [n, unit] = raw.split(' ')
      const count = Number(n)
      return Number.isFinite(count) && unit && unit in UNITS ? { n: count, unit } : null
    }
    case 'is':
    case 'isNot':
    case 'between':
      return raw.split(',').filter(Boolean)
    case 'gt':
    case 'lt':
      return Number(raw)
    default:
      return raw
  }
}

function formatValue(c: Clause): string {
  if (c.op === 'empty') return 'true'
  if (c.op === 'inLast') {
    const v = c.value as { n: number; unit: string }
    return `${v.n} ${v.unit}`
  }
  return Array.isArray(c.value) ? c.value.join(',') : String(c.value)
}

export function stateFromQuery(query: Query): HistoryState {
  const clauses: Clause[] = []
  for (const f of asList(query.f)) {
    const first = f.indexOf(':')
    const second = f.indexOf(':', first + 1)
    if (first < 1 || second < 0) continue
    const key = f.slice(0, first)
    const op = f.slice(first + 1, second) as Op
    if (!KEYS.has(key) || !OPS.has(op)) continue
    const value = parseValue(op, f.slice(second + 1))
    if (value !== null && !(typeof value === 'number' && Number.isNaN(value)))
      clauses.push({ key, op, value })
  }
  return {
    q: asList(query.q)[0] ?? '',
    clauses,
    archived: asList(query.archived)[0] === '1',
  }
}

/** The query for a state. Unfinished clauses (no value yet) stay out of the URL. */
export function queryFromState(state: HistoryState): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  if (state.q) out.q = state.q
  if (state.archived) out.archived = '1'
  const f = state.clauses
    .filter(c => c.value !== null)
    .map(c => `${c.key}:${c.op}:${formatValue(c)}`)
  if (f.length) out.f = f
  return out
}

/** Same URL, so a route.query → state → route.query round trip is a no-op. */
export function sameQuery(a: Query, b: Query): boolean {
  const norm = (q: Query) =>
    JSON.stringify([asList(q.q), asList(q.archived), asList(q.f)].map(l => l.slice().sort()))
  return norm(a) === norm(b)
}

export function filterFields(sessions: Session[], projects: { name: string; title: string }[]) {
  const distinct = (pick: (s: Session) => (string | null)[]) =>
    [...new Set(sessions.flatMap(pick).filter((v): v is string => !!v))].sort()
  const options = (values: string[]) => values.map(v => ({ value: v, label: v }))
  const fields: FieldDef[] = [
    {
      key: 'project',
      label: 'Project',
      type: 'reference',
      options: projects.map(p => ({ value: p.name, label: p.title })),
    },
    {
      key: 'state',
      label: 'State',
      type: 'enum',
      options: (Object.keys(SESSION_DISPLAY) as Session['state'][]).map(s => ({
        value: s,
        label: SESSION_DISPLAY[s].label,
      })),
    },
    { key: 'tag', label: 'Tag', type: 'enum', options: options(distinct(s => s.tags)) },
    { key: 'model', label: 'Model', type: 'enum', options: options(distinct(s => [s.model])) },
    {
      key: 'origin',
      label: 'Origin',
      type: 'enum',
      options: [
        { value: 'odin', label: 'Started in Odin' },
        { value: 'external', label: 'Terminal' },
      ],
    },
    { key: 'lastRun', label: 'Last run', type: 'date' },
    { key: 'updated', label: 'Last updated', type: 'date' },
  ]
  return fields
}

function valuesOf(s: Session, key: string): string[] {
  switch (key) {
    case 'project':
      return s.projects ?? [s.project]
    case 'state':
      return [s.state]
    case 'tag':
      return s.tags
    case 'model':
      return s.model ? [s.model] : []
    case 'origin':
      return [s.origin]
    default:
      return []
  }
}

function dateClausePasses(value: string | null, c: Clause, now: number): boolean {
  const at = Date.parse(value ?? '')
  if (c.op === 'empty') return Number.isNaN(at)
  if (Number.isNaN(at)) return false
  if (c.op === 'inLast') {
    const v = c.value as { n: number; unit: string }
    return at >= now - v.n * (UNITS[v.unit] ?? UNITS.days!)
  }
  const day = Date.parse(`${String(c.value)}T00:00:00`)
  if (Number.isNaN(day)) return true
  return c.op === 'before' ? at < day : at >= day
}

export function clausePasses(s: Session, c: Clause, now = Date.now()): boolean {
  if (c.value === null) return true // not finished: constrains nothing yet
  if (c.key === 'lastRun') return dateClausePasses(lastRunAt(s), c, now)
  if (c.key === 'updated') return dateClausePasses(s.updatedAt, c, now)
  const have = valuesOf(s, c.key)
  if (c.op === 'empty') return have.length === 0
  const want = (Array.isArray(c.value) ? c.value : [c.value]).map(String)
  if (!want.length) return true
  const hit = have.some(v => want.includes(v))
  return c.op === 'isNot' ? !hit : hit
}

export function applyClauses(sessions: Session[], clauses: Clause[], now = Date.now()): Session[] {
  return clauses.length
    ? sessions.filter(s => clauses.every(c => clausePasses(s, c, now)))
    : sessions
}
