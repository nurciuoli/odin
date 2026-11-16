import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProjectFolders } from "@odin/shared/api";
import { expandHome } from "../config.ts";
import { HttpError } from "../http/util.ts";

export async function browseProjectFolders(input: unknown, defaultPath = homedir()): Promise<ProjectFolders> {
  if (input !== undefined && (typeof input !== "string" || !input.trim())) {
    throw new HttpError(400, "path must be a non-empty absolute folder path");
  }
  const expanded = input === undefined ? defaultPath : expandHome((input as string).trim());
  if (!isAbsolute(expanded)) throw new HttpError(400, "path must be absolute");
  const path = resolve(expanded);
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const folders = await Promise.all(entries.filter(e => !e.name.startsWith(".")).map(async e => {
      const child = join(path, e.name);
      const directory = e.isDirectory() || (e.isSymbolicLink() && await stat(child).then(s => s.isDirectory(), () => false));
      return directory ? { name: e.name, path: child } : null;
    }));
    const parent = dirname(path);
    return {
      path, parent: parent === path ? null : parent,
      folders: folders.filter(f => f !== null).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    };
  } catch {
    throw new HttpError(400, "Can't open this folder. Check that it exists and Odin has permission to read it.");
  }
}
