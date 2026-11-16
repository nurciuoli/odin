// Stages the packaged app under apps/desktop/stage/ (docs/desktop.md#packaging):
//   stage/app/        the Electron app (main.js bundled from src/main.ts, preload.cjs, package.json) -> app.asar
//   stage/resources/  extraResources: core/ (bundled core + schema + SDK), web/, library/, tokens.css, adapter/
// Core runs on the app's own Node (ELECTRON_RUN_AS_NODE=1); see src/resources.ts. Run after `yarn build:web`.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { runtimePackages } from "../src/package-runtime.ts";

const desktop = resolve(import.meta.dirname, "..");
const repo = resolve(desktop, "../..");
const stage = join(desktop, "stage");
const app = join(stage, "app");
const res = join(stage, "resources");
const SDK = "@anthropic-ai/claude-agent-sdk";

rmSync(stage, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
mkdirSync(res, { recursive: true });

const common = { bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning", legalComments: "none" } as const;

// Shell main process.
await build({ ...common, entryPoints: [join(desktop, "src/main.ts")], outfile: join(app, "main.js"), external: ["electron"] });
cpSync(join(desktop, "src/preload.cjs"), join(app, "preload.cjs"));
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "odin", productName: "Odin", version: pkg.version, private: true, type: "module", main: "main.js" }, null, 2));

// Core: bundled JS beside its schema/migrations (db.ts reads them from its own directory) and the real SDK package.
const core = join(res, "core");
await build({
  ...common,
  entryPoints: { index: join(repo, "packages/core/src/index.ts"), "host-mcp": join(repo, "packages/core/src/harness/grok/host-mcp.ts") },
  outdir: core,
  external: [SDK, "@opencode/sdk", "@opencode/client"],
});
cpSync(join(repo, "packages/core/src/db/schema.sql"), join(core, "schema.sql"));
cpSync(join(repo, "packages/core/src/db/migrations"), join(core, "migrations"), { recursive: true });
writeFileSync(join(core, "package.json"), JSON.stringify({ type: "module", private: true }));
// The Claude SDK (with its platform binary and its MCP/API peers) and OpenCode (runtime-loaded plugins, schema
// modules and native optional dependencies) stay external: copy their resolved dependency graphs.
const modules = join(repo, "node_modules");
if (!existsSync(join(modules, `${SDK}-${process.platform}-${process.arch}`))) throw new Error(`missing the ${SDK} binary for ${process.platform}-${process.arch}: run yarn install`);
for (const from of runtimePackages(modules, [SDK, "@opencode/sdk", "@opencode/client"])) {
  cpSync(from, join(core, "node_modules", relative(modules, from)), { recursive: true, dereference: true });
}

// Claude Code adapter script, plus a .cmd wrapper that run them on the app's own Node (no system Node needed).
const adapter = join(res, "adapter");
await build({
  ...common,
  entryPoints: { "odin-hook": join(repo, "adapters/claude-code/src/odin-hook.ts") },
  outdir: adapter,
});
writeFileSync(join(adapter, "package.json"), JSON.stringify({ type: "module", private: true }));
for (const script of ["odin-hook"]) {
  // <install>\resources\adapter\x.cmd -> <install>\Odin.exe
  writeFileSync(join(adapter, `${script}.cmd`), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\..\\Odin.exe" "%~dp0${script}.js" %*\r\n`);
}

// Web app, library seed, artifact theme.
const web = join(repo, "packages/web/dist");
if (!existsSync(join(web, "index.html"))) throw new Error("packages/web/dist is missing: run yarn build:web");
cpSync(web, join(res, "web"), { recursive: true });
cpSync(join(repo, "templates/library"), join(res, "library"), { recursive: true });
cpSync(join(repo, "packages/web/src/styles/tokens.css"), join(res, "tokens.css"));

console.log(`staged ${stage}`);
