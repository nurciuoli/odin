// Actions a screen offers to the command palette's `>` list while it's mounted: the session screen's Fork, Ask a side
// question, Toggle files. The palette adds its own app-wide actions (New session, Go home, …) in front of these.
import { shallowRef, type ShallowRef } from 'vue'
import type { IconName } from '@/components/Icon'

export interface AppCommand {
  /** Stable id; registering the same id again replaces the earlier entry. */
  id: string
  label: string
  icon?: IconName
  /** Right-aligned meta, usually the shortcut (`keyLabel('Alt+/')`). */
  hint?: string
  /** Shown instead of running when the action can't happen right now. */
  disabledReason?: string
  run: () => void
}

const registry: ShallowRef<AppCommand[]> = shallowRef([])

/** Offers an action in the palette; returns the function that withdraws it. */
export function registerCommand(command: AppCommand): () => void {
  registry.value = [...registry.value.filter(c => c.id !== command.id), command]
  return () => {
    registry.value = registry.value.filter(c => c !== command)
  }
}

export function useCommands(): Readonly<ShallowRef<AppCommand[]>> {
  return registry
}
