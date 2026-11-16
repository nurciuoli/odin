import type { RegisterRoutes } from "../services.ts";
import { ARTIFACT_HEADERS } from "../artifacts/routes.ts";
import { HttpError } from "../http/util.ts";

/** Rich notebook output has exactly the same opaque-origin boundary as HTML artifacts. */
export const registerNotebookOutputRoutes: RegisterRoutes = (router, _deps, services) => {
  router.get("/a/notebooks/:id/:cellId/:index", ({ params, res }) => {
    if (!/^\d{1,5}$/.test(params.index)) throw new HttpError(404, "unknown notebook output");
    const cell = services.notebooks.snapshot(params.id).cells.find(cell => cell.id === params.cellId);
    const output = cell?.outputs[Number(params.index)];
    if (!output || output.type !== "display") throw new HttpError(404, "unknown notebook output");
    const string = (value: unknown): string | null => typeof value === "string" ? value : Array.isArray(value) && value.every(line => typeof line === "string") ? value.join("") : null;
    let html = string(output.data["text/html"]);
    const svg = string(output.data["image/svg+xml"]);
    const javascript = string(output.data["application/javascript"]);
    if (html === null && svg !== null) html = svg;
    if (html === null && javascript !== null) html = `<script>${javascript.replace(/<\/script/gi, "<\\/script")}</script>`;
    if (html === null) throw new HttpError(404, "no rich output available");
    res.writeHead(200, { ...ARTIFACT_HEADERS, "content-length": Buffer.byteLength(html) }).end(html);
  });
};
