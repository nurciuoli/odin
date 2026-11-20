// types.ts — the data model every chat component speaks. Owned by the
// orchestrator; components import from here so the thread, composer, sidebar
// and the scripted demo agent all agree on shape.
import type { Status } from '@/styles/status'
import type { TraceStep } from '@/components/AgentTrace/AgentTrace.vue'
import type { DiffHunk } from '@/components/CodeBlock/Diff.vue'
import type { IconName } from '@/components/Icon/icons'

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatAuthor {
  name: string
  kind: 'person' | 'agent'
  /** stable id for avatar hue */
  id?: string
}

/** a tool call is a trace step — same rendering, same status rules */
export type ToolCall = TraceStep

export interface Attachment {
  id: string
  name: string
  /** bytes */
  size?: number
  kind?: 'file' | 'image' | 'code' | 'data'
  status?: 'uploading' | 'ready' | 'failed'
  /** 0–1 while uploading */
  progress?: number
  /** Image URL (data URL or same-origin preview). Shown as a thumbnail and in the preview. */
  src?: string
  /** Text already in memory. The preview shows it without a request. */
  text?: string
  /** Fetched when the chip is opened. Used for text the transcript did not carry. */
  previewUrl?: string
}

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'always'

export interface ApprovalRequest {
  id: string
  /** tool the agent wants to run, e.g. 'write_reconciliation_report' */
  tool: string
  /** one-line plain-language summary of the effect */
  summary: string
  target?: string
  input?: unknown
  diff?: DiffHunk[]
  /** high risk = destructive / external side effects; changes the card's emphasis */
  risk?: 'low' | 'high'
  state: ApprovalState
  /** who resolved it, once resolved */
  resolvedBy?: string
  resolvedAt?: string
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; durationMs?: number }
  | { type: 'tools'; steps: ToolCall[] }
  | { type: 'approval'; approval: ApprovalRequest }
  | { type: 'attachments'; files: Attachment[] }

export interface ChatMessage {
  id: string
  role: ChatRole
  author: ChatAuthor
  /** ISO timestamp */
  at: string
  parts: MessagePart[]
  /** the last part is still being produced */
  streaming?: boolean
  /** the turn failed — shown under the parts with a retry affordance */
  error?: string
}

export interface Conversation {
  id: string
  title: string
  status: Status
  /** ISO timestamp of last activity */
  updatedAt: string
  preview?: string
  unread?: boolean
  pinned?: boolean
  agent?: string
}

export interface PlanStep {
  id: string
  label: string
  status: Status
  detail?: string
}

export interface ComposerCommand {
  id: string
  /** what follows the slash, e.g. 'plan' for /plan */
  name: string
  description?: string
  icon?: IconName
  /** free-text argument hint shown after the name, e.g. '<file>' */
  argumentHint?: string
  /** other names that match while filtering */
  aliases?: string[]
  /** section label; commands with the same group are listed together */
  group?: string
  /** argument forms offered as a second step once the command is chosen */
  choices?: ComposerCommandChoice[]
}

export interface ComposerCommandChoice {
  label: string
  /** text inserted after `/name `; empty or ending in a space means the user types the rest */
  insert: string
  /** what to type next, shown while the rest is typed */
  hint?: string
}

/** One `@` file-reference suggestion. */
export interface ComposerFileMatch {
  path: string
  kind: 'file' | 'directory'
}

export interface ModelOption {
  id: string
  label: string
  hint?: string
  /** Relative price, 1 (cheapest) to 4. Absent when unknown. Setting this or `effortLevels` switches the composer's model menu to the compact picker. */
  cost?: 1 | 2 | 3 | 4
  /** The levels this model offers, lowest first. The picker shows an effort control under the chosen model when set. */
  effortLevels?: { id: string; label: string }[]
}
