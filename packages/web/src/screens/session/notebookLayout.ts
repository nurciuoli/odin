// What the notebook pane does as it gets wider or narrower. The pane's own width decides (not the window's): the
// toolbar folds what does not fit into a menu, and a wide pane grows an outline beside the cells.
import type { NotebookCell } from '@odin/shared/notebooks'
import type { Status } from '@/styles/status'

/** The pane is this wide (px) or wider: the outline shows. */
export const OUTLINE_MIN_WIDTH = 1100

export const showOutline = (paneWidth: number) => paneWidth >= OUTLINE_MIN_WIDTH

/**
 * How many toolbar buttons (in priority order, `widths` in px) stay as buttons in `available` px. When all of them
 * fit there is no menu; otherwise room is kept for the menu button, and the rest fold into it.
 */
export function visibleToolbarCount(
  available: number,
  widths: number[],
  gap: number,
  menuWidth: number,
): number {
  const row = (count: number, extra: number) =>
    widths.slice(0, count).reduce((sum, w) => sum + w, 0) + gap * Math.max(0, count - 1) + extra
  if (row(widths.length, 0) <= available) return widths.length
  let count = widths.length - 1
  while (count > 0 && row(count, gap + menuWidth) > available) count--
  return count
}

export interface OutlineEntry {
  key: string
  cellId: string
  kind: 'heading' | 'cell'
  /** Heading level 1–6; 0 for a code cell. */
  level: number
  text: string
  /** 1-based position among the cells, for the label. */
  number: number
}

/** Markdown headings and code cells, in document order. Headings inside code fences do not count. */
export function outlineEntries(cells: NotebookCell[]): OutlineEntry[] {
  const out: OutlineEntry[] = []
  cells.forEach((cell, index) => {
    const number = index + 1
    if (cell.kind === 'code') {
      const first = cell.source.split('\n').find(line => line.trim()) ?? ''
      out.push({
        key: cell.id,
        cellId: cell.id,
        kind: 'cell',
        level: 0,
        text: first.trim() || 'Empty cell',
        number,
      })
      return
    }
    let fenced = false
    cell.source.split('\n').forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
      const m = !fenced && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
      if (m)
        out.push({
          key: `${cell.id}:${i}`,
          cellId: cell.id,
          kind: 'heading',
          level: m[1]!.length,
          text: m[2]!,
          number,
        })
    })
  })
  return out
}

/** "0.4s", "14s", "2m 05s". */
export function formatDuration(ms: number): string {
  if (!(ms >= 0)) return ''
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export type CellStatus = Extract<Status, 'idle' | 'running' | 'ok' | 'failed' | 'queued'>

/** WSL is Windows-only. The desktop shell says which platform it runs on; a plain browser does not, so no WSL there. */
export const wslAvailable = (platform: string | undefined) => platform === 'win32'
