import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SessionFileEntry, SessionTextFile } from "@odin/shared/api";
import { HttpError } from "../http/util.ts";
import { createFileManager } from "./manage.ts";
import { createFileMap } from "./map.ts";
import { createFileSearch } from "./search.ts";
import type { Deps, FilesService, Services } from "../services.ts";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const versionOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function cleanPath(path: string, directory = false): string {
  if (typeof path !== "string" || path.includes("\0") || path.includes(":") || isAbsolute(path) || path.startsWith("\\")) {
    throw new HttpError(400, "Use a relative file path within this session");
  }
  const parts = path.replaceAll("\\", "/").split("/");
  if (parts.some(p => p === ".." || p.toLowerCase() === ".git" || /[. ]$/.test(p) && p !== ".")) {
    throw new HttpError(403, "This path is not available in the file viewer");
  }
  const cleaned = parts.filter(p => p && p !== ".").join("/");
  if (!directory && !cleaned) throw new HttpError(400, "A file path is required");
  return cleaned;
}

function translateError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") throw new HttpError(404, "File or directory no longer exists");
  if (code === "EACCES" || code === "EPERM" || code === "EBUSY") throw new HttpError(403, "File is inaccessible or in use");
  throw new HttpError(500, "Could not access this file");
}

/** Synchronous bounded operations keep Odin's own saves serialized. No watchers or model calls. */
export function createFilesService(_deps: Deps, services: Services): FilesService {
  const searchIn = createFileSearch();
  const mapIn = createFileMap();
  const manage = createFileManager(_deps, services);
  function target(sessionId: string, input: string, directory = false) {
    const session = services.sessions.get(sessionId);
    if (!session) throw new HttpError(404, "Unknown session");
    return { ...within(session.cwd, input, directory), session };
  }
  /** `input` resolved inside `cwd`: no links, nothing that escapes the folder. */
  function within(cwd: string, input: string, directory = false) {
    const path = cleanPath(input, directory);
    const root = realpathSync(cwd);
    let absolute = root;
    // Reject links, including links that currently point inside the root: saves never replace a link.
    for (const part of path.split("/").filter(Boolean)) {
      absolute = join(absolute, part);
      if (lstatSync(absolute).isSymbolicLink()) throw new HttpError(403, "Symbolic links are not supported in the file viewer");
    }
    const canonical = realpathSync(absolute);
    const rel = relative(root, canonical);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new HttpError(403, "Path is outside the session");
    return { path, absolute: canonical };
  }

  function readAt(path: string, absolute: string): SessionTextFile {
    const fd = openSync(absolute, "r");
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new HttpError(415, "Only regular text files can be opened");
      if (stat.size > MAX_FILE_BYTES) throw new HttpError(413, "Text previews are limited to 2 MiB");
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > MAX_FILE_BYTES) throw new HttpError(413, "Text previews are limited to 2 MiB");
      const bytes = buffer.subarray(0, length);
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new HttpError(415, "This file is not UTF-8 text"); }
      if (content.includes("\0")) throw new HttpError(415, "Binary files cannot be opened as text");
      return { path, content, version: versionOf(bytes), size: bytes.length };
    } finally { closeSync(fd); }
  }

  return {
    renameProject: manage.rename,
    moveProject: manage.move,
    duplicateProject: manage.duplicate,
    trashProject: manage.trash,
    listTrash: manage.listTrash,
    restoreTrash: manage.restore,
    purgeTrash: manage.purge,
    search(sessionId, query) {
      const session = services.sessions.get(sessionId);
      if (!session) throw new HttpError(404, "Unknown session");
      try { return searchIn(realpathSync(session.cwd), query); }
      catch (err) { return translateError(err); }
    },
    searchProject(name, query) {
      const project = services.projects.get(name);
      if (!project) throw new HttpError(404, "Unknown project");
      try { return searchIn(realpathSync(project.path), query); }
      catch (err) { return translateError(err); }
    },
    projectMap(name) {
      const project = services.projects.get(name);
      if (!project) throw new HttpError(404, "Unknown project");
      try { return mapIn(realpathSync(project.path)); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { files: [], truncated: false };
        return translateError(err);
      }
    },
    readProject(name, input) {
      const project = services.projects.get(name);
      if (!project) throw new HttpError(404, "Unknown project");
      try { const { path, absolute } = within(project.path, input); return readAt(path, absolute); }
      catch (err) { return translateError(err); }
    },
    list(sessionId, input = "") {
      try {
        const { path, absolute } = target(sessionId, input, true);
        if (!lstatSync(absolute).isDirectory()) throw new HttpError(400, "Choose a directory");
        const entries: SessionFileEntry[] = [];
        const children = readdirSync(absolute, { withFileTypes: true }).filter(e => e.name.toLowerCase() !== ".git" && !e.isSymbolicLink() && (e.isDirectory() || e.isFile()));
        children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const entry of children.slice(0, MAX_ENTRIES)) {
          try {
            const info = lstatSync(join(absolute, entry.name));
            if (info.isSymbolicLink() || !(info.isFile() || info.isDirectory())) continue;
            entries.push({ name: entry.name, path: path ? `${path}/${entry.name}` : entry.name, kind: info.isDirectory() ? "directory" : "file", size: info.isFile() ? info.size : null });
          } catch { /* A directory may change while it is being listed. */ }
        }
        return { path, entries, truncated: children.length > MAX_ENTRIES };
      } catch (err) { return translateError(err); }
    },
    read(sessionId, input) {
      try { const { path, absolute } = target(sessionId, input); return readAt(path, absolute); }
      catch (err) { return translateError(err); }
    },
    save(sessionId, input, content, version) {
      let temporary: string | undefined;
      try {
        if (typeof content !== "string" || typeof version !== "string" || !/^[a-f0-9]{64}$/.test(version)) throw new HttpError(400, "Content and a valid file version are required");
        if (content.includes("\0") || !content.isWellFormed()) throw new HttpError(400, "Content must be valid UTF-8 text");
        const bytes = Buffer.from(content, "utf8");
        if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, "Text files are limited to 2 MiB");
        const { path, absolute, session } = target(sessionId, input);
        const current = readAt(path, absolute);
        if (current.version !== version) throw new HttpError(409, "This file changed on disk. Your draft has not been saved; compare it with the latest file.");
        if (current.content === content) return current;
        const stat = lstatSync(absolute);
        if (stat.nlink > 1) throw new HttpError(403, "Hard-linked files cannot be edited in the file viewer");
        temporary = join(dirname(absolute), `.odin-save-${randomUUID()}.tmp`);
        const fd = openSync(temporary, "wx", stat.mode & 0o777);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        const checked = target(sessionId, input);
        if (checked.absolute !== absolute || readAt(path, absolute).version !== version) throw new HttpError(409, "This file changed on disk. Your draft has not been saved.");
        renameSync(temporary, absolute);
        temporary = undefined;
        const project = services.projects.get(session.project);
        if (project) services.projects.noteWritten(session.project, [relative(resolve(project.path), absolute).replaceAll("\\", "/")]);
        return { path, content, version: versionOf(bytes), size: bytes.length };
      } catch (err) { return translateError(err); }
      finally { if (temporary) { try { unlinkSync(temporary); } catch { /* Best-effort cleanup of our temporary file. */ } } }
    },
    create(sessionId, input, content = "") {
      try {
        if (typeof content !== "string" || content.includes("\0") || !content.isWellFormed()) throw new HttpError(400, "Content must be valid UTF-8 text");
        const bytes = Buffer.from(content, "utf8");
        if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, "Text files are limited to 2 MiB");
        const session = services.sessions.get(sessionId);
        if (!session) throw new HttpError(404, "Unknown session");
        const path = cleanPath(input);
        // Folders are never created: the parent must already exist inside the session, reached without links.
        const slash = path.lastIndexOf("/");
        let folder: string;
        try { folder = within(session.cwd, slash < 0 ? "" : path.slice(0, slash), true).absolute; }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "The folder for this file does not exist");
          throw err;
        }
        if (!lstatSync(folder).isDirectory()) throw new HttpError(400, "Choose a folder for this file");
        const absolute = join(folder, path.slice(slash + 1));
        // `wx` fails on any existing entry, including a link, so the check and the create are one step.
        let fd: number;
        try { fd = openSync(absolute, "wx", 0o644); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "A file or folder already exists at this path");
          throw err;
        }
        let written = false;
        try { writeFileSync(fd, bytes); fsyncSync(fd); written = true; }
        finally {
          closeSync(fd);
          if (!written) { try { unlinkSync(absolute); } catch { /* Nothing partial is left behind when we can help it. */ } }
        }
        const project = services.projects.get(session.project);
        if (project) services.projects.noteWritten(session.project, [relative(resolve(project.path), absolute).replaceAll("\\", "/")]);
        return { path, content, version: versionOf(bytes), size: bytes.length };
      } catch (err) { return translateError(err); }
    },
  };
}
