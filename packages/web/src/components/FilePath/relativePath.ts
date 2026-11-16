// File paths for display: relative to a root (a session's cwd, a worktree), forward slashes, split so the file name
// can stay visible when the directory part has to give way. Pure; no node:path (this runs in the browser and has to
// read Windows paths on any OS).

/** `C:\a`, `c:/a`, `\\server\share`, `//server/share`. */
const WINDOWS = /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/

const isAbsolute = (p: string) => p.startsWith('/') || p.startsWith('\\') || WINDOWS.test(p)
const slashes = (p: string) => p.replace(/\\/g, '/')
/** Collapses repeated separators (keeping a UNC path's leading pair) and drops trailing ones (not the root's). */
function tidy(p: string): string {
  const unc = /^\/\/[^/]/.test(p)
  let out = p.replace(/\/{2,}/g, '/')
  if (unc) out = `/${out}`
  if (out.length > 1 && !/^[a-zA-Z]:\/$/.test(out)) out = out.replace(/\/+$/, '')
  return out || '/'
}

/**
 * `path` relative to `root`, with forward slashes: `C:\repo\src\a.ts` under `C:\repo` → `src/a.ts`; the root itself
 * → `.`. Windows paths (a drive letter, a UNC prefix, or backslashes on either side) compare case-insensitively;
 * POSIX paths case-sensitively. A path outside the root, or any path when there is no root, comes back as given.
 * A path that is already relative comes back with forward slashes and no leading `./`.
 */
export function relativePath(path: string, root?: string | null): string {
  if (!path) return path
  if (!isAbsolute(path)) {
    const rel = tidy(slashes(path)).replace(/^(?:\.\/)+/, '')
    return rel === '' ? '.' : rel
  }
  if (!root || !isAbsolute(root)) return path
  const windows = WINDOWS.test(path) || WINDOWS.test(root) || /\\/.test(path + root)
  const p = tidy(slashes(path))
  const r = tidy(slashes(root))
  const key = (s: string) => (windows ? s.toLowerCase() : s)
  if (key(p) === key(r)) return '.'
  const prefix = r.endsWith('/') ? r : `${r}/`
  if (!key(p).startsWith(key(prefix))) return path
  return p.slice(prefix.length) || '.'
}

/** The last segment of a path (either separator); the path itself when it has none. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** A path split for display: everything up to and including the last separator, and the file name. */
export function splitPath(path: string): { dir: string; base: string } {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (i < 0 || i === path.length - 1) return { dir: '', base: path }
  return { dir: path.slice(0, i + 1), base: path.slice(i + 1) }
}
