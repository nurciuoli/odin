// Runtime configuration. Everything path-like can be pointed at a temp dir, so tests never touch ~/.odin.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CORE_PORT } from "@odin/shared";

export interface Config {
  /** ODIN_HOME, default ~/.odin. Holds state.db, env (the ingest token), pricing.json, library/, worktrees/. */
  home: string;
  /** <home>/state.db. The v1 database (odin.db) is left alone and never read. */
  dbPath: string;
  pricingPath: string;
  /** The library: plain files, one directory per asset kind (<home>/library). */
  libraryDir: string;
  /** Copied into an empty library on first boot (ODIN_LIBRARY_SEED, default the repo's templates/library). */
  librarySeedDir: string;
  /** Session worktrees: <home>/worktrees/<project>/<branch slug>. */
  worktreesDir: string;
  /** The built web app (ODIN_WEB_DIST, default packages/web/dist). */
  webDist: string;
  /** Artifact theme tokens (ODIN_ARTIFACT_THEME, default packages/web/src/styles/tokens.css). */
  artifactThemePath: string;
  /** Claude Code adapter scripts, holding odin-hook.{js,ts} (ODIN_ADAPTER_DIR, default adapters/claude-code/src). */
  adapterDir: string;
  port: number;
  /** Always loopback: Odin is single-user and local. */
  host: string;
  /** This home's id from <home>/instance (filled in at boot; empty in tests). Returned by GET /api/health. */
  instance: string;
  /** Bearer token for POST /api/ingest (ODIN_INGEST_TOKEN, else generated into <home>/env on first boot). */
  ingestToken: string;
  /** GITHUB_TOKEN, else `gh auth token` at boot. Empty disables GitHub. Never log or return it. */
  githubToken: string;
  /** Where the token came from, for the settings screen. */
  githubTokenSource: "env" | "gh" | null;
  githubApiUrl: string;
  /** GitHub poll. 0 disables the timer. */
  githubSyncMs: number;
  /** Re-read PROJECT.md, agents and git state, and discover external sessions. 0 disables the timer. */
  projectsRescanMs: number;
  /** ODIN_FAKE_HARNESS=1: run sessions on the scripted fake driver (no model calls). For demos and e2e checks. */
  fakeHarness: boolean;
  /** ODIN_HARNESSES: comma-separated harness ids to offer (e.g. "claude,codex"). Default "claude". "all" offers every driver. */
  harnesses: string[] | null;
  /**
   * Extra Host and Origin names, from ODIN_EXTRA_HOSTS. Used when Tailscale Serve reaches loopback
   * with the machine's tailnet name. Empty means localhost only.
   */
  extraHosts: string[];
  /**
   * ODIN_ALLOWED_LOGIN: the one Tailscale login allowed in. When set, every request except the ingest post and
   * the health check must carry it in Tailscale-User-Login, which Tailscale Serve sets. Empty means no login check.
   */
  allowedLogin: string;
}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Comma-separated hostnames. Ports, schemes and wildcards are rejected so a typo cannot widen the check. */
export function extraHostsFrom(value: string | undefined): string[] {
  const hosts = (value ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  for (const host of hosts) {
    if (!HOST_NAME.test(host)) throw new Error(`ODIN_EXTRA_HOSTS entry "${host}" must be a hostname`);
  }
  return [...new Set(hosts)];
}

/** ODIN_HARNESSES parsed: null means every driver; unset means Claude only. */
export function harnessesFrom(value: string | undefined): string[] | null {
  const ids = (value ?? "claude").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  return ids.includes("all") ? null : [...new Set(ids)];
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** An env override (resolved, ~ expanded), else a path relative to this file in the repo layout. */
function pathFrom(value: string | undefined, repoRelative: string): string {
  const v = (value ?? "").trim();
  return v ? resolve(expandHome(v)) : resolve(import.meta.dirname, repoRelative);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const home = resolve(expandHome(env.ODIN_HOME || "~/.odin"));
  const githubToken = (env.GITHUB_TOKEN ?? "").trim();
  const base: Config = {
    home,
    dbPath: join(home, "state.db"),
    pricingPath: join(home, "pricing.json"),
    libraryDir: join(home, "library"),
    worktreesDir: join(home, "worktrees"),
    librarySeedDir: pathFrom(env.ODIN_LIBRARY_SEED, "../../../templates/library"),
    webDist: pathFrom(env.ODIN_WEB_DIST, "../../web/dist"),
    artifactThemePath: pathFrom(env.ODIN_ARTIFACT_THEME, "../../web/src/styles/tokens.css"),
    adapterDir: pathFrom(env.ODIN_ADAPTER_DIR, "../../../adapters/claude-code/src"),
    port: Number(env.ODIN_PORT) || CORE_PORT,
    host: "127.0.0.1",
    instance: "",
    ingestToken: (env.ODIN_INGEST_TOKEN ?? "").trim(),
    githubToken,
    githubTokenSource: githubToken ? "env" : null,
    githubApiUrl: (env.GITHUB_API_URL || "https://api.github.com").trim().replace(/\/+$/, ""),
    githubSyncMs: 2 * 60_000,
    projectsRescanMs: 60_000,
    fakeHarness: env.ODIN_FAKE_HARNESS === "1",
    harnesses: harnessesFrom(env.ODIN_HARNESSES),
    extraHosts: extraHostsFrom(env.ODIN_EXTRA_HOSTS),
    allowedLogin: (env.ODIN_ALLOWED_LOGIN ?? "").trim().toLowerCase(),
  };
  const merged = { ...base, ...overrides };
  if (overrides.home) {
    if (!overrides.dbPath) merged.dbPath = join(merged.home, "state.db");
    if (!overrides.pricingPath) merged.pricingPath = join(merged.home, "pricing.json");
    if (!overrides.libraryDir) merged.libraryDir = join(merged.home, "library");
    if (!overrides.worktreesDir) merged.worktreesDir = join(merged.home, "worktrees");
  }
  return merged;
}
