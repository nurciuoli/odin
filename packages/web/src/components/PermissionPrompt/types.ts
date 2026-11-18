// The data a permission prompt shows and the answer it gives. Generic (no Odin types): screens map their
// harness's request onto it.
import type { DiffHunk } from '@/components/CodeBlock/Diff.vue'

/** Where an "always allow" rule is saved. `once` saves nothing. */
export type PermissionScope = 'once' | 'session' | 'project' | 'local' | 'user'

export interface PermissionPromptQuestion {
  id?: string
  question: string
  header: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

export interface PermissionPromptRequest {
  id: string
  /** tool: run a tool; plan: approve a plan (markdown in `plan`); question: answer `questions`. */
  kind: 'tool' | 'plan' | 'question'
  /** Tool name, e.g. "Bash". */
  tool: string
  /** One plain sentence from the harness, e.g. "Claude wants to run: npm test". Rendered as text. */
  title: string
  description?: string
  /** The tool input, shown as a property list or code (command, file path…). */
  input?: Record<string, unknown>
  /** For edits: the change as a diff. */
  diff?: DiffHunk[]
  /** For kind plan. */
  plan?: string
  /** For kind question (AskUserQuestion). */
  questions?: PermissionPromptQuestion[]
  /** False hides the "always allow" choices. */
  canAlwaysAllow: boolean
  /** Opens on Deny and offers no one-key approve. */
  defaultToDeny: boolean
}

export type PermissionPromptAnswer =
  | {
      behavior: 'allow'
      scope: PermissionScope
      /** question answers, keyed by question text */ answers?: Record<string, string>
    }
  | { behavior: 'deny'; message?: string }
