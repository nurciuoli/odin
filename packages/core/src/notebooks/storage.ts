import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, lstatSync, statSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { HttpError } from "../http/util.ts";

export interface IpynbCell {
  id: string;
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  metadata: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: Record<string, unknown>[];
  [key: string]: unknown;
}
export interface IpynbDocument {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: IpynbCell[];
  [key: string]: unknown;
}
export interface NotebookSnapshot { document: IpynbDocument; revision: string }
export const NOTEBOOK_MAX_BYTES = 32 * 1024 * 1024;
const revision = (raw: string) => createHash("sha256").update(raw).digest("hex");
const PRETTY_NOTEBOOK_BYTES = 4 * 1024 * 1024;

export const EMPTY_NOTEBOOK = (): IpynbDocument => ({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } }, cells: [] });

/** Normalises a project-relative notebook path (forward slashes) or throws 400. */
export function normalizeNotebookPath(path: unknown): string {
  if (typeof path !== "string" || !path.endsWith(".ipynb") || path.includes("\u0000") || path.includes(":") || isAbsolute(path) || path.startsWith("\\") || path.startsWith("/")) throw new HttpError(400, "choose a project-relative .ipynb path");
  const parts = path.replaceAll("\\", "/").split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[. ]$/.test(part)) || parts.at(-1) === ".ipynb") throw new HttpError(400, "invalid notebook path");
  return parts.join("/");
}

/**
 * Notebooks are ordinary project files addressed by (project root, relative path). The file stays authoritative;
 * every access re-validates the path against the root, refusing symlinks and non-regular files.
 */
export function createNotebookStorage() {
  function path(root: string, rel: string, makeDirectories = false) {
    const clean = normalizeNotebookPath(rel);
    const parts = clean.split("/");
    let target = realpathSync(root);
    for (const part of parts.slice(0, -1)) {
      target = join(target, part);
      try {
        const entry = lstatSync(target);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new HttpError(403, "notebook directory must be a regular project directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!makeDirectories) throw new HttpError(404, "notebook file is missing");
        mkdirSync(target);
      }
    }
    target = join(target, parts.at(-1)!);
    try { const entry = lstatSync(target); if (!entry.isFile() || entry.isSymbolicLink()) throw new HttpError(400, "notebook must be a regular file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return target;
  }
  function exists(root: string, rel: string): boolean {
    try { lstatSync(path(root, rel)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error instanceof HttpError && error.status === 404)) return false; throw error; }
  }
  function readRaw(target: string): string {
    let raw: string;
    try { if (statSync(target).size > NOTEBOOK_MAX_BYTES) throw new HttpError(413, "notebook is too large"); raw = readFileSync(target, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "notebook file is missing"); throw error; }
    if (Buffer.byteLength(raw) > NOTEBOOK_MAX_BYTES) throw new HttpError(413, "notebook is too large");
    return raw;
  }
  function read(root: string, rel: string): NotebookSnapshot {
    const raw = readRaw(path(root, rel));
    let document: IpynbDocument;
    try { document = JSON.parse(raw); }
    catch { throw new HttpError(409, "notebook contains invalid JSON; repair it before editing"); }
    if (document?.nbformat !== 4 || !Array.isArray(document.cells) || !document.metadata || typeof document.metadata !== "object")
      throw new HttpError(409, "unsupported notebook format");
    const ids = new Set<string>();
    for (const [index, cell] of document.cells.entries()) {
      if (!cell || !["code", "markdown", "raw"].includes(cell.cell_type) ||
          !(typeof cell.source === "string" || (Array.isArray(cell.source) && cell.source.every(s => typeof s === "string"))))
        throw new HttpError(409, "notebook contains an invalid cell");
      // Older nbformat 4 notebooks omit cell IDs. A deterministic ID remains stable until persisted.
      if (!cell.id) cell.id = createHash("sha256").update(JSON.stringify([index, cell.source])).digest("hex").slice(0, 32);
      if (typeof cell.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(cell.id) || ids.has(cell.id)) throw new HttpError(409, "notebook contains invalid or duplicate cell IDs");
      ids.add(cell.id);
      if (!cell.metadata || typeof cell.metadata !== "object" || Array.isArray(cell.metadata)) cell.metadata = {};
      if (cell.cell_type === "code" && !Array.isArray(cell.outputs)) cell.outputs = [];
      if (cell.execution_count !== undefined && cell.execution_count !== null && (!Number.isSafeInteger(cell.execution_count) || cell.execution_count < 0)) throw new HttpError(409, "notebook contains an invalid execution count");
      for (const output of cell.outputs ?? []) {
        if (!output || typeof output !== "object" || Array.isArray(output) || !["stream", "error", "display_data", "execute_result"].includes(String(output.output_type))) throw new HttpError(409, "notebook contains an invalid output");
        if (output.output_type === "stream" && !(typeof output.text === "string" || Array.isArray(output.text) && output.text.every(line => typeof line === "string"))) throw new HttpError(409, "notebook contains an invalid stream output");
        if (output.output_type === "error" && (!Array.isArray(output.traceback) || !output.traceback.every(line => typeof line === "string"))) throw new HttpError(409, "notebook contains an invalid error output");
        if (["display_data", "execute_result"].includes(String(output.output_type)) && (!output.data || typeof output.data !== "object" || Array.isArray(output.data))) throw new HttpError(409, "notebook contains invalid display data");
      }
    }
    return { document, revision: revision(raw) };
  }
  function write(root: string, rel: string, document: IpynbDocument, expectedRevision: string | null): NotebookSnapshot {
    const target = path(root, rel, expectedRevision === null);
    if (expectedRevision === null) {
      try { lstatSync(target); throw new HttpError(409, "notebook already exists"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const checkRevision = () => {
      if (expectedRevision !== null && revision(readRaw(path(root, rel))) !== expectedRevision) throw new HttpError(409, "notebook changed; reload before saving");
    };
    checkRevision();
    // Jupyter introduced durable cell IDs in nbformat 4.5.
    const portable = Number.isSafeInteger(document.nbformat_minor) && document.nbformat_minor >= 5
      ? document : { ...document, nbformat_minor: 5 };
    let raw = JSON.stringify(portable) + "\n";
    const bytes = Buffer.byteLength(raw);
    if (bytes > NOTEBOOK_MAX_BYTES) throw new HttpError(413, "notebook is too large");
    if (bytes <= PRETTY_NOTEBOOK_BYTES) {
      const pretty = JSON.stringify(portable, null, 2) + "\n";
      if (Buffer.byteLength(pretty) <= NOTEBOOK_MAX_BYTES) raw = pretty;
    }
    const temporary = target + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 });
      checkRevision();
      renameSync(temporary, target);
    }
    finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    return { document: portable, revision: revision(raw) };
  }
  /** Writes an empty notebook; 409 if the file exists. */
  function create(root: string, rel: string): NotebookSnapshot { return write(root, rel, EMPTY_NOTEBOOK(), null); }
  return { path, exists, read, write, create };
}
