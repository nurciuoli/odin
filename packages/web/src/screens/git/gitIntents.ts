// Git actions asked for from elsewhere (the ⌘K palette's `@` list) and carried out by the session's branch chip,
// which owns the dialogs a switch or a sync may need (dirty tree, diverged branch). `hasGitHandler()` says whether a
// chip is mounted to take them.
export type GitIntent =
  | { kind: 'switch'; branch: string }
  | { kind: 'new-session'; branch: string }
  | { kind: 'new-branch'; branch: string }
  | { kind: 'fetch' | 'pull' | 'push' | 'stash' }
  | { kind: 'stash-action'; action: 'apply' | 'pop' | 'drop'; ref: string }

type Handler = (intent: GitIntent) => void
const handlers: Handler[] = []

/** The chip registers; returns the function that removes it again. The newest handler wins. */
export function onGitIntent(fn: Handler): () => void {
  handlers.push(fn)
  return () => {
    const i = handlers.indexOf(fn)
    if (i >= 0) handlers.splice(i, 1)
  }
}

export function hasGitHandler(): boolean {
  return handlers.length > 0
}

/** False when no chip is mounted to carry it out. */
export function sendGitIntent(intent: GitIntent): boolean {
  const fn = handlers[handlers.length - 1]
  if (!fn) return false
  fn(intent)
  return true
}
