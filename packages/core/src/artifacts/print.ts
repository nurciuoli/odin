import { randomBytes } from "node:crypto";
import type { RegisterRoutes } from "../services.ts";
import { ARTIFACT_HEADERS } from "./routes.ts";
import { HttpError } from "../http/util.ts";

const id = (raw: string) => /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : null;
/** Browser printing is initiated by the trusted outer page; the report keeps its opaque origin. */
export const registerArtifactPrintRoutes: RegisterRoutes = (router, _deps, services) => {
  router.get("/api/artifacts/:id/print/:version", ({ params, res }) => {
    const artifactId = id(params.id), version = id(params.version);
    if (artifactId === null || version === null || services.artifacts.html(artifactId, version) === null) throw new HttpError(404, "unknown artifact version");
    const nonce = randomBytes(18).toString("base64");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Print report</title><style>body{margin:0}nav{padding:1em}iframe{display:block;border:0;width:100%;height:100vh}@media print{nav{display:none}iframe{overflow:visible}}</style></head><body><nav><button id="print" type="button">Print / Save as PDF</button></nav><iframe id="report" title="Report" sandbox="allow-scripts allow-forms" src="/a/${artifactId}/${version}/print"></iframe><script nonce="${nonce}">const frame=document.getElementById('report');window.addEventListener('message',e=>{if(e.source===frame.contentWindow&&e.data?.type==='odin.print-size'&&Number.isFinite(e.data.height))frame.style.height=Math.min(100000,Math.max(100,e.data.height))+'px'});document.getElementById('print').addEventListener('click',()=>window.print());</script></body></html>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'self'`, "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(html);
  });
  router.get("/a/:id/:version/print", ({ params, res }) => {
    const artifactId = id(params.id), version = id(params.version);
    const html = artifactId !== null && version !== null ? services.artifacts.html(artifactId, version) : null;
    if (html === null) throw new HttpError(404, "unknown artifact version");
    const measure = `<script>(()=>{const send=()=>parent.postMessage({type:'odin.print-size',height:Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0)},'*');addEventListener('load',send);if(typeof ResizeObserver==='function')new ResizeObserver(send).observe(document.documentElement);send()})()</script>`;
    const page = html + measure;
    res.writeHead(200, { ...ARTIFACT_HEADERS, "content-length": Buffer.byteLength(page) }).end(page);
  });
};
