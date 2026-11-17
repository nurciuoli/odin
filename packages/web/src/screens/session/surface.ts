// What the workspace surface lends every document header: the way back to the browser and the way to put the whole
// panel away. Provided by SessionWorkbench, injected by DocumentHeader, so each document wears the same chrome without
// threading props through every viewer.
import type { InjectionKey, Ref } from 'vue'

export interface SurfaceChrome {
  /** The browser is on show (no document is). */
  browsing: Readonly<Ref<boolean>>
  /** Put the browser on show, with its filter focused: the user asked for it. */
  showBrowser: () => void
  hidePanel: () => void
}

export const SURFACE: InjectionKey<SurfaceChrome> = Symbol('workspace-surface')
