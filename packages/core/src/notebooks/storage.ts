import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
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

/** Files are addressed by generated IDs, never user-supplied paths. The notebook remains authoritative. */
export function createNotebookStorage(home: string) {
  const root = join(home, "notebooks");
  function path(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new HttpError(400, "invalid notebook ID");
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) throw new HttpError(400, "notebook directory cannot be a symbolic link");
    const target = join(root, `${id}.ipynb`);
    try { const entry = lstatSync(target); if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 1) throw new HttpError(400, "notebook must be a regular unlinked file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return target;
  }
  function read(id: string): NotebookSnapshot {
    let raw: string;
    try { const target = path(id); if (statSync(target).size > NOTEBOOK_MAX_BYTES) throw new HttpError(413, "notebook is too large"); raw = readFileSync(target, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "notebook file is missing"); throw error; }
    if (Buffer.byteLength(raw) > NOTEBOOK_MAX_BYTES) throw new HttpError(413, "notebook is too large");
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
  function write(id: string, document: IpynbDocument, expectedRevision: string | null): NotebookSnapshot {
    const target = path(id);
    if (expectedRevision !== null) {
      if (read(id).revision !== expectedRevision) throw new HttpError(409, "notebook changed; reload before saving");
    } else {
      try { lstatSync(target); throw new HttpError(409, "notebook already exists"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const raw = JSON.stringify(document, null, 2) + "\n";
    if (Buffer.byteLength(raw) > NOTEBOOK_MAX_BYTES) throw new HttpError(413, "notebook is too large");
    const temporary = target + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 });
      if (expectedRevision !== null && read(id).revision !== expectedRevision) throw new HttpError(409, "notebook changed; reload before saving");
      renameSync(temporary, target);
    }
    finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    return { document, revision: revision(raw) };
  }
  return { path, read, write };
}
