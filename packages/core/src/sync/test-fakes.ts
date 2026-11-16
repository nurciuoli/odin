// Small fakes for sync tests: a ProjectsService that knows names and repos (and nothing else), a
// SessionsService that knows records (get/list/patch, rows in the sessions table), and a sync stack (fake GitHub +
// real sync) on an in-memory DB.
import type { DatabaseSync } from "node:sqlite";
import type { ProjectSettings, Session } from "@odin/shared/api";
import { emptyMetrics } from "@odin/shared/session";
import { testDeps } from "../test-helpers.ts";
import type { ProjectRef, ProjectsService, SessionPatch, SessionsService } from "../services.ts";
import { notImplemented } from "../stub.ts";
import { FakeGitHub } from "./fake-github.ts";
import { createSyncService } from "./service.ts";

function settings(name: string, repo: string | null): ProjectSettings {
  return { title: name, description: "", repo, defaultBranch: "main", commands: {} };
}

/** Only list/get are real. Rows go into `projects` too, since gh_map and pulls reference it. */
export function fakeProjects(db: DatabaseSync, initial: { name: string; repo: string | null }[]): ProjectsService & { setRepo(name: string, repo: string | null): void } {
  const refs = new Map<string, ProjectRef>();
  const add = (name: string, repo: string | null) => {
    refs.set(name, { name, path: `/tmp/${name}`, settings: settings(name, repo), manifestError: null, missing: false });
    db.prepare("INSERT OR IGNORE INTO projects (name, path, manifest, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)").run(name, `/tmp/${name}`, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z");
  };
  for (const p of initial) add(p.name, p.repo);
  const impl: Record<string, unknown> = {
    list: () => [...refs.values()],
    get: (name: string) => refs.get(name) ?? null,
    setRepo: (name: string, repo: string | null) => add(name, repo),
    close: () => {},
  };
  const stub = notImplemented<ProjectsService>("projects");
  return new Proxy({} as ProjectsService & { setRepo(name: string, repo: string | null): void }, {
    get: (_t, prop) => (typeof prop === "string" && prop in impl ? impl[prop] : (stub as any)[prop]),
  });
}

export interface FakeSessions extends SessionsService {
  /** Inserts a record (and its row, so joins and branch lookups see it). */
  add(input: { id: string; project?: string; branch?: string | null; createdAt?: string }): Session;
  patches: { id: string; patch: SessionPatch }[];
}

/** Only add/get/list/patch are real; patch applies pull and metrics (shallow per key) like sessions does. */
export function fakeSessions(db: DatabaseSync): FakeSessions {
  const records = new Map<string, Session>();
  const patches: { id: string; patch: SessionPatch }[] = [];
  const impl: Record<string, unknown> = {
    patches,
    add(input: { id: string; project?: string; branch?: string | null; createdAt?: string }): Session {
      const at = input.createdAt ?? "2026-10-01T00:00:00Z";
      const session: Session = {
        id: input.id, harness: "claude", project: input.project ?? "odin", projects: [input.project ?? "odin"], title: input.id, tags: [], pinned: false, archived: false,
        origin: "odin", state: "idle", waitingFor: null, cwd: "/tmp/x", workspace: { kind: "checkout" }, branch: input.branch ?? null,
        model: null, permissionMode: null, agent: null, agentVersion: null, templateId: null, parentId: null, aside: false,
        pull: null, createdAt: at, updatedAt: at, endedAt: null, error: null, metrics: emptyMetrics(),
      };
      db.prepare(
        `INSERT INTO sessions (id, harness, project, title, origin, state, cwd, branch, created_at, updated_at, metrics)
         VALUES (?, 'claude', ?, ?, 'odin', 'idle', '/tmp/x', ?, ?, ?, ?)`,
      ).run(session.id, session.project, session.title, session.branch, at, at, JSON.stringify(session.metrics));
      records.set(session.id, session);
      return structuredClone(session);
    },
    get: (id: string) => (records.has(id) ? structuredClone(records.get(id)!) : null),
    list: () => [...records.values()].map((x) => structuredClone(x)),
    patch(id: string, patch: SessionPatch): Session {
      const cur = records.get(id);
      if (!cur) throw new Error(`no session ${id}`);
      patches.push({ id, patch: structuredClone(patch) });
      const { metrics, ...rest } = patch;
      const next: Session = { ...cur, ...(rest as Partial<Session>), metrics: { ...cur.metrics, ...metrics } };
      records.set(id, next);
      db.prepare("UPDATE sessions SET pull = ?, metrics = ? WHERE id = ?").run(next.pull ? JSON.stringify(next.pull) : null, JSON.stringify(next.metrics), id);
      return structuredClone(next);
    },
    close: () => {},
  };
  const stub = notImplemented<SessionsService>("sessions");
  return new Proxy({} as FakeSessions, {
    get: (_t, prop) => (typeof prop === "string" && prop in impl ? impl[prop] : (stub as any)[prop]),
  });
}

/** Fake GitHub + real sync for project "odin" on the fake's repo. */
export function syncStack(o: { repo?: string | null; token?: string; fetch?: (gh: FakeGitHub) => typeof fetch } = {}) {
  const gh = new FakeGitHub();
  const deps = testDeps({ githubFetch: o.fetch ? o.fetch(gh) : gh.fetch });
  deps.config.githubToken = o.token ?? gh.token;
  deps.config.githubApiUrl = gh.base;
  const projects = fakeProjects(deps.db, [{ name: "odin", repo: o.repo === undefined ? gh.repo : o.repo }]);
  const sessions = fakeSessions(deps.db);
  const sync = createSyncService(deps, { projects, sessions });
  return { gh, deps, projects, sessions, sync, close: () => sync.close() };
}
