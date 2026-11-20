// The session timeline's model: one step per user message, with a summary of what Claude did before the next one.
// Pure, so the rules are testable without a DOM. The Session screen draws it (SessionTimeline.vue) and scrolls the
// thread to a step by the user message id.
import type { TranscriptEntry } from '@odin/shared/harness'
import { presentTool, toolPath } from '@/components/ToolCall/summary'

export interface TimelineStep {
  /** The user message's transcript id (also what the thread tags its message with). */
  id: string
  /** 1-based. */
  n: number
  prompt: string
  at: string | null
  /** Claude's last text before the next user message ('' while it hasn't answered yet). */
  reply: string
  /** Tool calls, not counting ones nested inside another call. */
  tools: number
  /** Distinct workspace files edited or written. */
  files: number
  /** Tool calls that failed (a denied or stopped call is the user's choice, not a failure). */
  failed: number
  /** Agents started. */
  agents: number
}

const CHANGE = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

export function buildTimeline(entries: TranscriptEntry[]): TimelineStep[] {
  const steps: TimelineStep[] = []
  let files = new Set<string>()
  let cur: TimelineStep | null = null
  for (const e of entries) {
    if (e.kind === 'user') {
      files = new Set()
      cur = {
        id: e.id,
        n: steps.length + 1,
        prompt: e.text.trim(),
        at: e.at ?? null,
        reply: '',
        tools: 0,
        files: 0,
        failed: 0,
        agents: 0,
      }
      steps.push(cur)
      continue
    }
    if (!cur || e.parentToolUseId) continue
    if (e.kind === 'assistant') {
      cur.reply = e.text.trim()
    } else if (e.kind === 'tool') {
      cur.tools++
      if (presentTool(e).name === 'Agent') cur.agents++
      if (
        e.result &&
        !e.result.ok &&
        e.result.status !== 'denied' &&
        e.result.status !== 'interrupted'
      )
        cur.failed++
      const shown = presentTool(e)
      if (CHANGE.has(shown.name)) {
        const path = toolPath(shown)
        if (path) files.add(path)
        cur.files = files.size
      }
    }
  }
  return steps
}

/** "14:05" from a step's timestamp, in the reader's time zone; '' when it has none. */
export function stepClock(at: string | null): string {
  if (!at) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** The step a key press lands on: moves by `delta` and stops at the ends. */
export function stepIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(count - 1, Math.max(0, current + delta))
}

/**
 * How much of the rail each step gets: how long it ran (the gap to the next message, capped at half an hour), or, for
 * the last step and steps without timestamps, how many tool calls it made. Log-scaled so one long step doesn't flatten
 * the rest, with a floor so a quick one still has something to point at.
 */
export function stepWeights(steps: TimelineStep[]): number[] {
  return steps.map((s, i) => {
    const t0 = s.at ? Date.parse(s.at) : NaN
    const t1 = steps[i + 1]?.at ? Date.parse(steps[i + 1]!.at!) : NaN
    const minutes =
      Number.isNaN(t0) || Number.isNaN(t1)
        ? Math.min(s.tools, 20) * 0.5
        : Math.min(30, Math.max(0, (t1 - t0) / 60000))
    return Math.log(1 + minutes) + 0.6
  })
}

/** The step on screen: the last one whose message has scrolled up to `top` (or the first, before any has). */
export function currentStep(tops: number[], top: number): number {
  let at = 0
  tops.forEach((t, i) => {
    if (t <= top) at = i
  })
  return at
}
