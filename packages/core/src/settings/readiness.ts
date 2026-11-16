// GET /api/readiness (docs/contracts.md#readiness): what a fresh machine still needs before Odin is useful.
// Model credentials are the environment's: the Claude login check looks only at whether a login *exists* (env var
// names, the credentials file's presence). It never opens the file or reads a value.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessInfo, ReadinessCheck, ReadinessResponse } from "@odin/shared/api";

export interface ReadinessInput {
  harnesses: HarnessInfo[];
  /** `git --version` output, or null when git could not be run. */
  gitVersion: string | null;
  github: { configured: boolean; source: "env" | "gh" | null };
  /** `gh` could be run (its auth state is not checked). */
  ghFound: boolean;
  /** A Claude login appears to exist: true, false, or null when this platform keeps it where Odin cannot see. */
  claudeLogin: boolean | null;
  projectCount: number;
}

export function readiness(input: ReadinessInput): ReadinessResponse {
  const checks: ReadinessCheck[] = [];
  const available = input.harnesses.filter((h) => h.available);
  checks.push(
    available.length
      ? { id: "harness", label: "Agent runtime", state: "ok", detail: available.map((h) => h.name).join(", "), fix: null }
      : {
          id: "harness",
          label: "Agent runtime",
          state: "missing",
          detail: input.harnesses.map((h) => `${h.name}: ${h.note ?? "not available"}`).join("; ") || "no runtimes registered",
          fix: "Install Claude Code (https://claude.com/claude-code), or set its path in Settings > Tools.",
        },
  );
  if (input.harnesses.some((h) => h.id === "claude" && h.available)) {
    checks.push(
      input.claudeLogin === true
        ? { id: "claude-auth", label: "Claude login", state: "ok", detail: "A login or API key is set up.", fix: null }
        : {
            id: "claude-auth",
            label: "Claude login",
            state: "warn",
            detail: input.claudeLogin === false ? "No Claude login found." : "Odin cannot see where this system keeps the Claude login.",
            fix: "Run `claude` in a terminal and use /login. Sessions fail to start until Claude is logged in.",
          },
    );
  }
  checks.push(
    input.gitVersion
      ? { id: "git", label: "Git", state: "ok", detail: input.gitVersion, fix: null }
      : { id: "git", label: "Git", state: "missing", detail: "git could not be run.", fix: "Install Git (https://git-scm.com), or set its path in Settings > Tools." },
  );
  checks.push(
    input.github.configured
      ? { id: "github", label: "GitHub", state: "ok", detail: input.github.source === "gh" ? "Token from gh." : "Token from GITHUB_TOKEN.", fix: null }
      : {
          id: "github",
          label: "GitHub",
          state: "optional",
          detail: input.ghFound ? "gh is installed but not logged in." : "No token; pull request sync is off.",
          fix: input.ghFound ? "Run `gh auth login`, then restart Odin." : "Install the GitHub CLI and run `gh auth login`, then restart Odin.",
        },
  );
  checks.push(
    input.projectCount > 0
      ? { id: "projects", label: "Projects", state: "ok", detail: `${input.projectCount} added.`, fix: null }
      : { id: "projects", label: "Projects", state: "todo", detail: "No projects yet.", fix: "Add a folder or repository as a project." },
  );
  return { ready: !checks.some((c) => c.state === "missing"), checks };
}

/** Env vars that mean Claude has credentials without a login (names only; values are never read). */
const CLAUDE_AUTH_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

/**
 * Whether a Claude login seems to exist. macOS keeps it in the keychain, which Odin does not touch: there a missing
 * file means "cannot tell" (null), not "no login".
 */
export function claudeLoginPresent(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): boolean | null {
  if (CLAUDE_AUTH_ENV.some((name) => Boolean(env[name]?.trim()))) return true;
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  if (existsSync(join(configDir, ".credentials.json"))) return true;
  return platform === "darwin" ? null : false;
}

/** First line of `<binary> --version`, or null if it cannot be run within 5 s. */
export function toolVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).split(/\r?\n/)[0]!.trim() || null);
    });
  });
}
