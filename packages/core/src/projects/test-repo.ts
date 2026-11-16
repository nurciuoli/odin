// Shared fixtures for the projects service tests (split across files so node --test runs them in parallel).
import { after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../http/util.ts";
import { stubServices, testDeps } from "../test-helpers.ts";
import { createProjectsService } from "./service.ts";

export const root = realpathSync(mkdtempSync(join(tmpdir(), "odin-projects-")));
after(() => rmSync(root, { recursive: true, force: true }));

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
let counter = 0;
/** The number in the most recent `makeRepo()` directory name (`repo<n>`). */
export const repoCount = () => counter;

/** A repo on `main` with one commit, and (when asked) a bare origin it was pushed to. */
export function makeRepo(opts: { origin?: boolean; files?: Record<string, string> } = {}): { path: string; origin: string | null } {
  const dir = join(root, `repo${++counter}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(dir, "README.md"), "hi\n");
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "init");
  let origin: string | null = null;
  if (opts.origin) {
    origin = join(root, `origin${counter}.git`);
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    git(dir, "remote", "add", "origin", origin);
    git(dir, "push", "--quiet", "-u", "origin", "main");
  }
  return { path: dir, origin };
}

export function setup() {
  const deps = testDeps();
  const projects = createProjectsService(deps, stubServices({}));
  return { deps, projects };
}

export const status = async (p: Promise<unknown>) => p.then(() => 0, (e) => (e instanceof HttpError ? e.status : -1));
