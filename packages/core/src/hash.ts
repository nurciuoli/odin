// Content versions. One rule for library assets and the files they become in a project, so drift is a hash compare:
// sha256 over the files sorted by path, each as `<path>\0<normaliseContent(content)>\0`. Paths are relative to the
// asset root; a single-file asset has one entry named `<id><ext>` (e.g. `reviewer.md`).
import { createHash } from "node:crypto";
import type { AssetFiles } from "@odin/shared/api";
import { normaliseContent } from "@odin/shared/library";

export function filesHash(files: AssetFiles): string {
  const h = createHash("sha256");
  for (const path of Object.keys(files).sort()) h.update(`${path}\0${normaliseContent(files[path]!)}\0`);
  return h.digest("hex");
}

/** The version of one file named `name`. */
export function fileHash(name: string, content: string): string {
  return filesHash({ [name]: content });
}
