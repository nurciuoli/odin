// Boots Odin: config, the ingest token, the GitHub token, then the server.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INGEST_TOKEN_ENV } from "@odin/shared";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/db.ts";
import { createApp } from "./server.ts";
import { readToolPaths } from "./tools/resolve.ts";
import { installShutdownHandlers } from "./shutdown.ts";
import { clearRuntime, instanceId, writeRuntime } from "./runtime.ts";

/** <home>/env holds ODIN_INGEST_TOKEN=…; created on first boot with mode 600. */
function ingestToken(home: string): string {
  const file = join(home, "env");
  if (existsSync(file)) {
    const m = new RegExp(`^${INGEST_TOKEN_ENV}=(.+)$`, "m").exec(readFileSync(file, "utf8"));
    if (m) return m[1]!.trim();
  }
  const token = randomBytes(24).toString("base64url");
  writeFileSync(file, `${INGEST_TOKEN_ENV}=${token}\n`, { mode: 0o600 });
  return token;
}

/** The gh binary: the Settings override from the app_settings row (services don't exist yet), else PATH. */
function ghBinary(dbPath: string): string {
  try {
    const db = openDb(dbPath);
    try {
      return readToolPaths(db).gh ?? "gh";
    } finally {
      db.close();
    }
  } catch {
    return "gh";
  }
}

/** `gh auth token`. The token is never logged; failures are silent (sync is simply off). */
function ghToken(binary: string): string {
  try {
    return execFileSync(binary, ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const config = loadConfig();
mkdirSync(config.home, { recursive: true });
if (!config.ingestToken) config.ingestToken = ingestToken(config.home);
if (!config.githubToken) {
  config.githubToken = ghToken(ghBinary(config.dbPath));
  config.githubTokenSource = config.githubToken ? "gh" : null;
}
// Harness processes (and their Bash tools) inherit this process's environment: keep Odin's secrets in config only.
// Model credentials are not Odin's: whatever the environment gives the harness (a Claude Code login, an API key)
// passes through untouched and is never read here.
for (const name of ["GITHUB_TOKEN", "GH_TOKEN", INGEST_TOKEN_ENV]) delete process.env[name];

config.instance = instanceId(config.home);

const app = createApp({ config });
const addr = await app.listen();
writeRuntime(config.home, { port: addr.port, pid: process.pid, instance: config.instance, startedAt: new Date().toISOString() });
console.log(`odin on http://${addr.address}:${addr.port}${config.githubToken ? "" : " (GitHub sync off: no token)"}${config.fakeHarness ? " (fake harness: no model calls)" : ""}`);

installShutdownHandlers(process, () => app.close().finally(() => clearRuntime(config.home, process.pid)), (code) => process.exit(code));
