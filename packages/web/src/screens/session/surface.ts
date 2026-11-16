// What the workspace surface lends every document header: the way back to the navigator and the way to put the whole
// panel away. Provided by SessionWorkbench, injected by DocumentHeader, so each document wears the same chrome without
// threading props through every viewer.
import type { InjectionKey, Ref } from 'vue'

export interface SurfaceChrome {
  /** The navigator is open as a drawer. */
  browsing: Ref<boolean>
  /** Id of the drawer, for aria-controls. */
  drawerId: string
  toggleBrowse: () => void
  hidePanel: () => void
}

export const SURFACE: InjectionKey<SurfaceChrome> = Symbol('workspace-surface')
