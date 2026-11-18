// Dynamic layout: which panels stay open when the window is too narrow for all of them. The conversation comes
// first. Side panels (Details, then the app sidebar) step aside to give it room, and come back on their own when
// the room does. Pure helpers plus one tiny shared signal, so the rules are testable without a DOM.
import { onBeforeUnmount, ref, type Ref } from 'vue'

/** The least width the conversation column should ever be squeezed to. */
export const CHAT_MIN = 480
/** The narrowest the docked preview pane gets (its own limit, shared here so the rules agree with it). */
export const PREVIEW_MIN = 480
/** The Details panel's width when docked beside the conversation. */
export const DETAILS_WIDTH = 420
/** The app sidebar's expanded width. */
export const SIDEBAR_WIDTH = 288

/** Whether Details can dock beside the conversation without squeezing it below CHAT_MIN. */
export function detailsFit(screenWidth: number, dockedWidth: number): boolean {
  return screenWidth - dockedWidth - DETAILS_WIDTH >= CHAT_MIN
}

/** The widest the preview pane may be while the conversation keeps CHAT_MIN. Never below the pane's own minimum. */
export function maxPreviewWidth(screenWidth: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(PREVIEW_MIN, Math.floor(screenWidth - CHAT_MIN)))
}

/**
 * Whether the sidebar should fold to its icon rail. `demand` is the width the current screen asks of the main
 * area (0 for none). It is judged against the main area as it would be with the sidebar open, so folding it
 * does not itself make the answer flip back.
 */
export function sidebarCrowded(viewportWidth: number, demand: number): boolean {
  return demand > 0 && viewportWidth - SIDEBAR_WIDTH < demand
}

/** The width the open screen asks of the main area. A screen sets it while it is mounted. */
const demand = ref(0)
export const layoutDemand: Readonly<Ref<number>> = demand
export function setLayoutDemand(px: number) {
  demand.value = px
}
/** Release the demand when the screen that set it goes away. */
export function useLayoutDemand(): (px: number) => void {
  onBeforeUnmount(() => setLayoutDemand(0))
  return setLayoutDemand
}
