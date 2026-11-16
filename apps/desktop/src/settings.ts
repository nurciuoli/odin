// The app settings the shell reads from GET /api/settings, read defensively: fields may be missing on an older core
// (notifyOnFinished, launcherShortcut, editorCommand arrive with contract 4).

export const DEFAULT_SHORTCUT = "CommandOrControl+Shift+Space";

export interface ShellSettings {
  notifyOnWaiting: boolean;
  notifyOnFinished: boolean;
  /** null = turned off. */
  launcherShortcut: string | null;
  editorCommand: string | null;
}

export const DEFAULT_SETTINGS: ShellSettings = {
  notifyOnWaiting: true,
  notifyOnFinished: true,
  launcherShortcut: DEFAULT_SHORTCUT,
  editorCommand: null,
};

/** From a `SettingsResponse` body (or anything else). Missing or malformed fields take the defaults. */
export function readShellSettings(body: unknown): ShellSettings {
  const s = body && typeof body === "object" ? (body as { settings?: unknown }).settings : undefined;
  const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const shortcut =
    o.launcherShortcut === null
      ? null
      : typeof o.launcherShortcut === "string" && o.launcherShortcut.trim()
        ? o.launcherShortcut.trim()
        : DEFAULT_SHORTCUT;
  return {
    notifyOnWaiting: bool(o.notifyOnWaiting, true),
    notifyOnFinished: bool(o.notifyOnFinished, true),
    launcherShortcut: shortcut,
    editorCommand: typeof o.editorCommand === "string" && o.editorCommand.trim() ? o.editorCommand.trim() : null,
  };
}

/** Roots `openPath` accepts: every registered project path, plus Odin's worktrees dir (`<home>/worktrees`). */
export function openRoots(projectsBody: unknown, worktreesDir: string): string[] {
  const roots: string[] = [];
  if (Array.isArray(projectsBody))
    for (const p of projectsBody)
      if (p && typeof p === "object" && typeof (p as { path?: unknown }).path === "string" && (p as { path: string }).path)
        roots.push((p as { path: string }).path);
  roots.push(worktreesDir);
  return roots;
}
