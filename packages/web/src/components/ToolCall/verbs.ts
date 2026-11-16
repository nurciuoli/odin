// The verb a tool's rail step shows: present tense while it runs, past tense once it has finished
// (failed and cancelled steps use the past tense too; their meta carries the status word).
import { toolTitle } from './summary'

const VERBS: Record<string, [live: string, done: string]> = {
  Read: ['Reading', 'Read'],
  NotebookRead: ['Reading', 'Read'],
  Grep: ['Searching', 'Searched'],
  Glob: ['Searching', 'Searched'],
  Search: ['Searching', 'Searched'],
  Edit: ['Editing', 'Edited'],
  MultiEdit: ['Editing', 'Edited'],
  NotebookEdit: ['Editing', 'Edited'],
  Write: ['Writing', 'Wrote'],
  Bash: ['Running', 'Ran'],
  PowerShell: ['Running', 'Ran'],
  Shell: ['Running', 'Ran'],
  Cmd: ['Running', 'Ran'],
  Terminal: ['Running', 'Ran'],
  WebFetch: ['Fetching', 'Fetched'],
  WebSearch: ['Searching the web', 'Searched the web'],
  Agent: ['Agent working', 'Agent finished'],
  Task: ['Agent working', 'Agent finished'],
  List: ['Listing', 'Listed'],
  Todos: ['Updating todos', 'Updated todos'],
  Question: ['Asking', 'Asked'],
  Delete: ['Deleting', 'Deleted'],
  Move: ['Moving', 'Moved'],
}

export const THINKING_VERBS: { live: string; done: string } = { live: 'Thinking', done: 'Thought' }

/** Both tenses of a tool's verb. MCP tools and anything unknown read "Calling X" / "Called X". */
export function toolVerbs(name: string): { live: string; done: string } {
  const title = toolTitle(name)
  const v = VERBS[title] ?? VERBS[name]
  if (v) return { live: v[0], done: v[1] }
  return { live: `Calling ${title}`, done: `Called ${title}` }
}

/** The verb for a tool: `live` true = present tense. */
export function toolVerb(name: string, live: boolean): string {
  const v = toolVerbs(name)
  return live ? v.live : v.done
}
