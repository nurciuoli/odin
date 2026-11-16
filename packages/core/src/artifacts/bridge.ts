// The script core injects into every artifact page (docs/contracts.md#artifacts): `window.odin = { submit, theme }`.
// It is a convenience, not a security boundary: the artifact is untrusted and could post the same message itself.
// What keeps it contained is the iframe sandbox (no allow-same-origin) and the CSP on /a/, and the app only accepts
// `odin.submit` messages whose source is that iframe, then asks the user before sending anything to the session.
import { readFileSync } from "node:fs";

/** Largest `submit(data)` payload, as JSON bytes. The app and POST /api/artifacts/:id/submit enforce the same limit. */
export const SUBMIT_MAX_BYTES = 64 * 1024;

/** The `--iu-*` custom properties declared on `:root`, as `{ "--iu-accent": "#e07b4a", … }`. */
export function parseThemeTokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of clean.matchAll(/(?:^|[},;\s]):root\s*\{([^}]*)\}/g)) {
    for (const m of block[1]!.matchAll(/(--iu-[\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) out[m[1]!] = m[2]!;
  }
  return out;
}

const cachedThemes = new Map<string, Record<string, string>>();

/**
 * Read a tokens.css once per path (config.artifactThemePath; ODIN_ARTIFACT_THEME overrides). A missing file (e.g. a
 * core-only checkout) gives an empty theme, not an error.
 */
export function loadTheme(path: string): Record<string, string> {
  let theme = cachedThemes.get(path);
  if (!theme) {
    try {
      theme = parseThemeTokens(readFileSync(path, "utf8"));
    } catch (err) {
      console.warn(`artifact theme: couldn't read ${path}: ${err instanceof Error ? err.message : err}`);
      theme = {};
    }
    cachedThemes.set(path, theme);
  }
  return theme;
}

const LINE_SEP = String.fromCharCode(0x2028), PARA_SEP = String.fromCharCode(0x2029);

/** JSON that is safe inside a <script> element: no `<` (so no `</script>` or `<!--`) and no JS line separators. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").split(LINE_SEP).join("\\u2028").split(PARA_SEP).join("\\u2029");
}

// Plain ES5-ish JS so any artifact's page can run it. __CONFIG__ is replaced with scriptJson({ artifactId, version, theme, maxBytes }).
const BRIDGE_SOURCE = `(function () {
  "use strict";
  var config = __CONFIG__;
  function bytes(text) {
    return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : text.length * 3;
  }
  function submit(data) {
    var json = JSON.stringify(data);
    if (json === undefined) throw new TypeError("odin.submit: data must be JSON (an object, array, string, number, boolean or null)");
    if (bytes(json) > config.maxBytes) throw new RangeError("odin.submit: data is over " + config.maxBytes + " bytes of JSON");
    parent.postMessage({ type: "odin.submit", artifactId: config.artifactId, version: config.version, data: JSON.parse(json) }, "*");
  }
  window.odin = { submit: submit, theme: config.theme };
})();`;

/** The `<script>` element for one artifact version. */
export function bridgeScript(artifactId: number, version: number, theme: Record<string, string> = {}): string {
  const config = scriptJson({ artifactId, version, theme, maxBytes: SUBMIT_MAX_BYTES });
  return `<script>${BRIDGE_SOURCE.replace("__CONFIG__", () => config)}</script>`;
}

/**
 * Put the script before the first `</head>`; with no `</head>`, at the start (after a leading doctype, so the page
 * doesn't drop into quirks mode). If an artifact hides `</head>` in a comment or string, only its own bridge breaks.
 */
export function injectBridge(html: string, script: string): string {
  const doc = html.startsWith("﻿") ? html.slice(1) : html;
  const head = /<\/head\s*>/i.exec(doc);
  if (head) return doc.slice(0, head.index) + script + doc.slice(head.index);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(doc);
  const at = doctype ? doctype[0].length : 0;
  return doc.slice(0, at) + script + doc.slice(at);
}
