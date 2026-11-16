// Shared constants. Types live in api.ts, harness.ts, events.ts, ingest.ts; helpers in labels.ts, session.ts,
// library.ts, transcript.ts, agents.ts, pricing.ts.

/** The preferred port. The desktop shell moves to a free one when another program (or another home's core) has it. */
export const CORE_PORT = 8790;
/** <home>/instance: a random id naming this home. `GET /api/health` returns it, so a client can tell its core apart. */
export const INSTANCE_FILE = "instance";
/** <home>/runtime.json: written by a running core so hooks and the shell find its port. */
export const RUNTIME_FILE = "runtime.json";
export interface RuntimeInfo {
  port: number;
  pid: number;
  instance: string;
  startedAt: string;
}
/** Vite dev server; proxies /api and /a to core. */
export const WEB_DEV_PORT = 5190;
export const INGEST_TOKEN_ENV = "ODIN_INGEST_TOKEN";
/** Where an artifact version is served (sandboxed, own CSP): /a/<artifactId>/<version> */
export const ARTIFACT_PATH_PREFIX = "/a/";
/** The in-process MCP server Odin gives each session it runs (artifacts). Tools appear as mcp__odin__<name>. */
export const ODIN_MCP_SERVER = "odin";
