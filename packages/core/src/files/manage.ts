// Managing a project's files from the Files tab: rename, move, duplicate and a trash with restore. Every path is
// relative to the project folder, reached without links, and never inside .git. Deleting is always a move into
// <home>/trash/<project>/<id>/ (kept 7 days), so nothing is unlinked on the spot.
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileMoveResult, FileTrashEntry } from "@odin/shared/api";
import { HttpError } from "../http/util.ts";
import type { Deps, Services } from "../services.ts";

export const TRASH_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f-]{36}$/;

/** A single file or folder name: no separators, not dot-names, nothing Windows would trim or reject. */
export function checkName(name: unknown): string {
  if (typeof name !== "string") throw new HttpError(400, "A name is required");
  const n = name.trim();
  if (!n || n === "." || n === ".." || /[\\/\0:*?"<>|]/.test(n) || /[. ]$/.test(n) || n.toLowerCase() === ".git") throw new HttpError(400, `"${name}" can't be used as a file name`);
  if (n.length > 200) throw new HttpError(400, "That name is too long");
  return n;
}

function clean(input: unknown, what = "path"): string {
  if (typeof input !== "string" || input.includes("\0") || input.includes(":") || isAbsolute(input) || input.startsWith("\\")) throw new HttpError(400, `Use a ${what} relative to the project`);
  const parts = input.replaceAll("\\", "/").split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === ".." || p.toLowerCase() === ".git" || /[. ]$/.test(p))) throw new HttpError(403, "This path is not available");
  return parts.join("/");
}

const sizeOf = (abs: string): number | null => {
  const st = lstatSync(abs);
  if (st.isFile()) return st.size;
  let total = 0;
  for (const e of readdirSync(abs, { withFileTypes: true })) if (!e.isSymbolicLink()) total += sizeOf(join(abs, e.name)) ?? 0;
  return total;
};

export function createFileManager(deps: Deps, services: Services) {
  const now = () => deps.now();
  const trashRoot = (project: string) => join(deps.config.home, "trash", project.replace(/[^a-zA-Z0-9._-]/g, "_"));

  function projectRoot(name: string): string {
    const p = services.projects.get(name);
    if (!p) throw new HttpError(404, "Unknown project");
    try {
      return realpathSync(p.path);
    } catch {
      throw new HttpError(409, "The project folder is missing on disk");
    }
  }

  /** The entry at `path` (an existing file or folder): refuses links anywhere on the way. */
  function existing(root: string, path: string): string {
    if (!path) throw new HttpError(400, "Choose a file or folder inside the project");
    let abs = root;
    for (const part of path.split("/")) {
      abs = join(abs, part);
      let st;
      try { st = lstatSync(abs); } catch { throw new HttpError(404, `${path} no longer exists`); }
      if (st.isSymbolicLink()) throw new HttpError(403, "Symbolic links are not supported here");
    }
    return abs;
  }

  /** An existing folder (or the root when `path` is empty). */
  function folder(root: string, path: string): string {
    if (!path) return root;
    const abs = existing(root, path);
    if (!lstatSync(abs).isDirectory()) throw new HttpError(400, `${path} is not a folder`);
    return abs;
  }

  const rel = (root: string, abs: string) => relative(root, abs).split(sep).join("/");

  function guardUse(abs: string, path: string) {
    if (services.notebooks.usesPath(abs)) throw new HttpError(409, `${path} is in use by a running notebook; stop its kernel first`);
  }

  function written(project: string, paths: string[]) {
    services.projects.noteWritten(project, paths);
  }

  function free(dir: string, name: string): string {
    if (!existsSync(join(dir, name))) return name;
    const ext = extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let n = 1; ; n++) {
      const candidate = `${stem} copy${n === 1 ? "" : ` ${n}`}${ext}`;
      if (!existsSync(join(dir, candidate))) return candidate;
    }
  }

  /** Rename, falling back to copy + remove across devices (the trash may live on another disk). */
  function relocate(from: string, to: string) {
    try {
      renameSync(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
      rmSync(from, { recursive: true, force: true });
    }
  }

  function translate(err: unknown): never {
    if (err instanceof HttpError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new HttpError(404, "File or folder no longer exists");
    if (code === "EEXIST" || code === "ENOTEMPTY") throw new HttpError(409, "Something already exists with that name");
    if (code === "EACCES" || code === "EPERM" || code === "EBUSY") throw new HttpError(403, "File or folder is inaccessible or in use");
    throw new HttpError(500, "Could not change this file");
  }

  function purgeExpired(project: string) {
    const dir = trashRoot(project);
    if (!existsSync(dir)) return;
    for (const id of readdirSync(dir)) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, id, "meta.json"), "utf8")) as { trashedAt: string };
        if (now().getTime() - Date.parse(meta.trashedAt) > TRASH_KEEP_MS) rmSync(join(dir, id), { recursive: true, force: true });
      } catch { /* An unreadable entry is left for the person to empty. */ }
    }
  }

  return {
    rename(project: string, input: unknown, newName: unknown): { path: string } {
      try {
        const root = projectRoot(project);
        const path = clean(input);
        const abs = existing(root, path);
        const name = checkName(newName);
        const to = join(dirname(abs), name);
        if (to === abs) return { path };
        // A case-only rename is the same entry on case-insensitive disks, so it is allowed.
        if (existsSync(to) && to.toLowerCase() !== abs.toLowerCase()) throw new HttpError(409, `"${name}" already exists in this folder`);
        guardUse(abs, path);
        renameSync(abs, to);
        const next = rel(root, to);
        written(project, [path, next]);
        return { path: next };
      } catch (err) { return translate(err); }
    },

    move(project: string, inputs: unknown, destination: unknown): FileMoveResult {
      try {
        if (!Array.isArray(inputs) || !inputs.length || inputs.length > 200) throw new HttpError(400, "Choose between 1 and 200 files to move");
        const root = projectRoot(project);
        const dir = folder(root, clean(destination, "folder"));
        const plan = inputs.map((i) => {
          const path = clean(i);
          const abs = existing(root, path);
          const to = join(dir, basename(abs));
          if (to === abs) throw new HttpError(409, `${path} is already in that folder`);
          if (lstatSync(abs).isDirectory() && (dir === abs || dir.startsWith(abs + sep))) throw new HttpError(400, `Can't move ${path} into itself`);
          if (existsSync(to)) throw new HttpError(409, `"${basename(abs)}" already exists in the destination`);
          guardUse(abs, path);
          return { path, abs, to };
        });
        if (new Set(plan.map((p) => p.to)).size !== plan.length) throw new HttpError(409, "Two of these files have the same name");
        const moved: FileMoveResult["moved"] = [];
        for (const p of plan) {
          renameSync(p.abs, p.to);
          moved.push({ from: p.path, to: rel(root, p.to) });
        }
        written(project, moved.flatMap((m) => [m.from, m.to]));
        return { moved };
      } catch (err) { return translate(err); }
    },

    duplicate(project: string, input: unknown): { path: string } {
      try {
        const root = projectRoot(project);
        const path = clean(input);
        const abs = existing(root, path);
        const st = lstatSync(abs);
        if (!st.isFile()) throw new HttpError(400, "Only files can be duplicated");
        if (st.size > 50 * 1024 * 1024) throw new HttpError(413, "Files over 50 MiB can't be duplicated here");
        const name = free(dirname(abs), basename(abs));
        const to = join(dirname(abs), name);
        cpSync(abs, to, { errorOnExist: true, force: false });
        const next = rel(root, to);
        written(project, [next]);
        return { path: next };
      } catch (err) { return translate(err); }
    },

    trash(project: string, inputs: unknown): FileTrashEntry[] {
      try {
        if (!Array.isArray(inputs) || !inputs.length || inputs.length > 200) throw new HttpError(400, "Choose between 1 and 200 files");
        const root = projectRoot(project);
        purgeExpired(project);
        const plan = inputs.map((i) => {
          const path = clean(i);
          const abs = existing(root, path);
          guardUse(abs, path);
          return { path, abs };
        });
        const out: FileTrashEntry[] = [];
        for (const p of plan) {
          const id = randomUUID();
          const dir = join(trashRoot(project), id);
          mkdirSync(dir, { recursive: true });
          const st = lstatSync(p.abs);
          const entry: FileTrashEntry = { id, path: p.path, kind: st.isDirectory() ? "directory" : "file", size: sizeOf(p.abs), trashedAt: now().toISOString() };
          writeFileSync(join(dir, "meta.json"), JSON.stringify(entry));
          relocate(p.abs, join(dir, "item"));
          out.push(entry);
        }
        written(project, out.map((e) => e.path));
        return out;
      } catch (err) { return translate(err); }
    },

    listTrash(project: string): FileTrashEntry[] {
      try {
        projectRoot(project);
        purgeExpired(project);
        const dir = trashRoot(project);
        if (!existsSync(dir)) return [];
        const out: FileTrashEntry[] = [];
        for (const id of readdirSync(dir)) {
          try { out.push(JSON.parse(readFileSync(join(dir, id, "meta.json"), "utf8")) as FileTrashEntry); } catch { /* skip */ }
        }
        return out.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt));
      } catch (err) { return translate(err); }
    },

    restore(project: string, id: string): { path: string } {
      try {
        if (!ID.test(id)) throw new HttpError(400, "Invalid trash id");
        const root = projectRoot(project);
        const dir = join(trashRoot(project), id);
        if (!existsSync(join(dir, "meta.json"))) throw new HttpError(404, "That item is no longer in the trash");
        const entry = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as FileTrashEntry;
        const path = clean(entry.path);
        const to = resolve(root, path);
        if (existsSync(to)) throw new HttpError(409, `${path} already exists; rename or move it first`);
        // The original folder may be gone: recreate it, but never through a link or outside the project.
        const parent = dirname(to);
        let walk = root;
        for (const part of rel(root, parent).split("/").filter(Boolean)) {
          walk = join(walk, part);
          if (!existsSync(walk)) mkdirSync(walk);
          else if (lstatSync(walk).isSymbolicLink() || !statSync(walk).isDirectory()) throw new HttpError(409, "The original folder is no longer a folder");
        }
        relocate(join(dir, "item"), to);
        rmSync(dir, { recursive: true, force: true });
        written(project, [path]);
        return { path };
      } catch (err) { return translate(err); }
    },

    /** Deletes one trashed item for good, or all of them when `id` is omitted. */
    purge(project: string, id?: string): void {
      try {
        projectRoot(project);
        if (id !== undefined) {
          if (!ID.test(id)) throw new HttpError(400, "Invalid trash id");
          rmSync(join(trashRoot(project), id), { recursive: true, force: true });
        } else rmSync(trashRoot(project), { recursive: true, force: true });
      } catch (err) { return translate(err); }
    },
  };
}
