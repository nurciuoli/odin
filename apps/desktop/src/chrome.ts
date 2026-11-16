// How the shell draws its window chrome. On Windows and Linux the OS would otherwise stack two bars
// (a menu row: Odin / Edit / View / Window, and a title row: Odin / minimize / maximize / close) above
// the app's own header. Those go away. The app header is the title bar, and the OS window buttons
// overlay its right edge. macOS keeps a normal title bar and the application menu.

/** Matches the web header band, and `--iu-ground` / `--iu-text` (the overlay cannot read CSS variables). */
export const TITLE_BAR_HEIGHT = 48;
export const TITLE_BAR_COLOR = "#121211";
export const TITLE_BAR_SYMBOL = "#eceae4";

export interface WindowChrome {
  titleBarStyle: "default" | "hidden";
  titleBarOverlay?: { color: string; symbolColor: string; height: number };
  autoHideMenuBar: boolean;
  backgroundColor: string;
}

/** Windows and Linux get the overlay title bar. macOS does not. */
export function hidesMenuBar(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "linux";
}

export function windowChrome(platform: NodeJS.Platform): WindowChrome {
  const backgroundColor = TITLE_BAR_COLOR;
  if (!hidesMenuBar(platform)) return { titleBarStyle: "default", autoHideMenuBar: false, backgroundColor };
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: TITLE_BAR_COLOR, symbolColor: TITLE_BAR_SYMBOL, height: TITLE_BAR_HEIGHT },
    autoHideMenuBar: true,
    backgroundColor,
  };
}

export type ShellCommand =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "reload"
  | "forceReload"
  | "toggleDevTools"
  | "resetZoom"
  | "zoomIn"
  | "zoomOut"
  | "toggleFullscreen"
  | "quit";

/** The slice of Electron's before-input-event this module needs. */
export interface KeyInput {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  isAutoRepeat?: boolean;
  isComposing?: boolean;
}

/**
 * Shortcuts the hidden menu used to own. Returns null for anything the page should handle.
 * With no menu bar, Windows drops these unless the shell handles them itself.
 */
export function shellCommand(input: KeyInput): ShellCommand | null {
  if (input.type !== "keyDown" || input.alt || input.isComposing) return null;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (key === "F11") return "toggleFullscreen";
  if (key === "F12") return "toggleDevTools";
  const cmd = input.control || input.meta;
  if (!cmd) return null;
  if (key === "q") return input.isAutoRepeat ? null : "quit";
  if (key === "z") return input.shift ? "redo" : "undo";
  if (key === "y" && !input.shift) return "redo";
  if (key === "x" && !input.shift) return "cut";
  if (key === "c" && !input.shift) return "copy";
  if (key === "v" && !input.shift) return "paste";
  if (key === "a" && !input.shift) return "selectAll";
  if (key === "r") return input.shift ? "forceReload" : "reload";
  if (key === "i" && input.shift) return "toggleDevTools";
  if (key === "0" && !input.shift) return "resetZoom";
  if (key === "=" || key === "+") return "zoomIn";
  if (key === "-" || key === "_") return "zoomOut";
  return null;
}
