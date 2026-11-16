// The Electron shell's bridge, when there is one. The web app also runs in a plain browser, so everything here
// treats `window.odinDesktop` as optional (docs/contracts.md#desktop-shell).
export type OpenTarget = 'editor' | 'terminal' | 'files'

/** What the shell says about the launcher shortcut (Settings shows a failed registration). */
export interface ShortcutStatus {
  /** The accelerator in use, or null when the shortcut is turned off. */
  accelerator: string | null
  registered: boolean
  /** Why registration failed (taken by another app, invalid accelerator). */
  error?: string
}

/**
 * The preload bridge. Every method is optional: an older or newer shell may lack one, so callers go through the
 * helpers below, which check before calling.
 */
export interface OdinDesktop {
  exportArtifactPdf?(id: number, version: number): Promise<boolean>
  platform: string
  /** The shell restricts this to registered projects and Odin worktrees; a refusal rejects. */
  openPath?(path: string, target: OpenTarget): Promise<void> | void
  /** Start at login (shell-local, off by default; starts hidden in the tray). */
  getLoginItem?(): Promise<boolean>
  setLoginItem?(on: boolean): Promise<void>
  shortcutStatus?(): Promise<ShortcutStatus>
  /** Opens `<home>/desktop.log` in the system viewer. */
  openLog?(): Promise<void>
}

declare global {
  interface Window {
    odinDesktop?: OdinDesktop
  }
}

export const OPEN_TARGETS: { id: OpenTarget; label: string }[] = [
  { id: 'editor', label: 'Open in editor' },
  { id: 'terminal', label: 'Open in terminal' },
  { id: 'files', label: 'Show in files' },
]

/** The bridge, or null in a browser. */
export function getDesktop(): OdinDesktop | null {
  return typeof window !== 'undefined' && window.odinDesktop ? window.odinDesktop : null
}

export function hasDesktop(): boolean {
  return getDesktop() !== null
}

/** Ask the shell to open a path. Returns false (and does nothing) when there is no shell or it refuses. */
export async function openPath(path: string, target: OpenTarget): Promise<boolean> {
  const bridge = getDesktop()
  if (typeof bridge?.openPath !== 'function') return false
  try {
    await bridge.openPath(path, target)
    return true
  } catch {
    return false
  }
}

/**
 * A pretend shell for mock-mode development (`?mock&desktop`, or `?mock&desktop=taken` to see a launcher shortcut
 * another app owns). Keeps state in memory and never touches the OS.
 */
export function fakeDesktop(opts: { taken?: boolean } = {}): OdinDesktop {
  let login = false
  return {
    platform: 'win32',
    openPath: () => undefined,
    getLoginItem: async () => login,
    setLoginItem: async on => {
      login = on
    },
    shortcutStatus: async () =>
      opts.taken
        ? {
            accelerator: 'CommandOrControl+Shift+Space',
            registered: false,
            error: 'Taken by another app',
          }
        : { accelerator: 'CommandOrControl+Shift+Space', registered: true },
    openLog: async () => undefined,
  }
}
