// Which paths `openPath` may open (docs/desktop.md#open-in-editor--terminal--files): only a real path
// under a registered project or a Odin worktree. Both the request and every root are resolved through realpath, so
// a symlink or junction inside a project that points elsewhere is refused.
import { realpath as fsRealpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface PathDeps {
  realpath(p: string): Promise<string>;
  /** Case-insensitive comparison (Windows, macOS default). */
  caseInsensitive: boolean;
}

export const defaultPathDeps: PathDeps = {
  realpath: (p) => fsRealpath(p),
  caseInsensitive: process.platform === "win32" || process.platform === "darwin",
};

export function isInside(child: string, root: string, caseInsensitive: boolean): boolean {
  const a = caseInsensitive ? child.toLowerCase() : child;
  const b = caseInsensitive ? root.toLowerCase() : root;
  const rel = relative(b, a);
  return rel === "" || (!!rel && !rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

/** The real path to open, or throws with a reason (the promise the page sees rejects). */
export async function checkOpenPath(requested: unknown, roots: string[], deps: PathDeps = defaultPathDeps): Promise<string> {
  if (typeof requested !== "string" || !requested || requested.includes("\0")) throw new Error("invalid path");
  if (!isAbsolute(requested)) throw new Error("path must be absolute");
  let real: string;
  try {
    real = await deps.realpath(resolve(requested));
  } catch {
    throw new Error("path does not exist");
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await deps.realpath(resolve(root));
    } catch {
      continue;
    }
    if (isInside(real, realRoot, deps.caseInsensitive)) return real;
  }
  throw new Error("path is outside every registered project and Odin worktree");
}
