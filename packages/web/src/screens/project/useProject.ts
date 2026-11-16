// The project the current /p/:name route is showing. ProjectLayout loads it; the tabs read it.
import { inject, type ComputedRef, type InjectionKey } from 'vue'
import type { ProjectDetail } from '@odin/shared/api'

export interface ProjectContext {
  /** Always set for a tab: the layout only renders tabs once the project has loaded. */
  detail: ComputedRef<ProjectDetail>
  /** Replace the loaded project, e.g. with the response of a config save. */
  setDetail(next: ProjectDetail): void
  reload(): Promise<void>
}

export const PROJECT_KEY: InjectionKey<ProjectContext> = Symbol('odin-project')

export function useProject(): ProjectContext {
  const ctx = inject(PROJECT_KEY, null)
  if (!ctx) throw new Error('useProject() must run under a project route')
  return ctx
}
