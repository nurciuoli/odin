import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { RegisterRoutes } from "../services.ts";
import { ARTIFACT_HEADERS } from "../artifacts/routes.ts";
import { HttpError } from "../http/util.ts";

const plotlyMime = "application/vnd.plotly.v1+json";
const require = createRequire(import.meta.url);
let plotlyScript: string | undefined;
const strings = (value: unknown): string | null =>
  typeof value === "string" ? value : Array.isArray(value) && value.every(line => typeof line === "string") ? value.join("") : null;
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function plotlyPage(value: unknown): string[] | null {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) return null;
  if (plotlyScript === undefined) {
    // Inline the trusted local distribution so the artifact's opaque-origin CSP stays unchanged.
    plotlyScript = readFileSync(require.resolve("plotly.js-strict-dist-min"), "utf8").replace(/<\/script/gi, "<\\/script");
  }
  const figure = JSON.stringify(value).replaceAll("<", "\\u003c");
  return [
    '<!doctype html><meta charset="utf-8"><style>html,body,#figure{height:100%;margin:0}#figure{width:100%}</style><div id="figure"></div><script>',
    plotlyScript,
    '</script><script type="application/json" id="specification">',
    figure,
    '</script><script>' +
    'const node = document.getElementById("figure");' +
    'const spec = JSON.parse(document.getElementById("specification").textContent);' +
    'const layout = {...spec.layout, autosize: true};' +
    'delete layout.width; delete layout.height;' +
    'async function draw() {' +
    '  await Plotly.newPlot(node, spec.data, layout, {responsive: true, displaylogo: false});' +
    '  if (Array.isArray(spec.frames) && spec.frames.length) await Plotly.addFrames(node, spec.frames);' +
    '}' +
    'draw().catch(() => { node.textContent = "Plotly could not render this figure."; });' +
    '</script>',
  ];
}

/** Rich notebook output has exactly the same opaque-origin boundary as HTML artifacts. */
export const registerNotebookOutputRoutes: RegisterRoutes = (router, _deps, services) => {
  router.get("/a/notebooks/:id/:cellId/:index", ({ params, res }) => {
    if (!/^\d{1,5}$/.test(params.index)) throw new HttpError(404, "unknown notebook output");
    const output = services.notebooks.output(params.id, params.cellId, Number(params.index));
    if (!output || output.type === "reference") throw new HttpError(404, "unknown notebook output");
    let page: string[] | null = null;
    if (output.type === "display") {
      page = plotlyPage(output.data[plotlyMime]);
      if (!page) {
        const html = strings(output.data["text/html"]) ?? strings(output.data["image/svg+xml"]);
        const javascript = strings(output.data["application/javascript"]);
        if (html !== null) page = [html];
        else if (javascript !== null) page = ["<script>" + javascript.replace(/<\/script/gi, "<\\/script") + "</script>"];
      }
      if (!page) for (const mime of ["image/png", "image/jpeg"]) {
        const data = strings(output.data[mime]);
        if (data && /^[A-Za-z0-9+/\s]*={0,2}$/.test(data)) {
          page = ['<!doctype html><meta charset="utf-8"><img style="max-width:100%;height:auto" alt="Cell plot" src="data:' + mime + ';base64,' + data + '">'];
          break;
        }
      }
      if (!page) page = ["<pre>" + escape(strings(output.data["text/plain"]) ?? "This display format is available in the notebook file.") + "</pre>"];
    } else {
      const content = output.type === "stream" ? output.text : [output.name + ": " + output.message, ...output.traceback].join("\n");
      page = ["<!doctype html><meta charset=\"utf-8\"><pre style=\"white-space:pre-wrap\">" + escape(content) + "</pre>"];
    }
    res.writeHead(200, { ...ARTIFACT_HEADERS, "content-length": page.reduce((bytes, chunk) => bytes + Buffer.byteLength(chunk), 0) });
    for (const chunk of page) res.write(chunk);
    res.end();
  });
};
