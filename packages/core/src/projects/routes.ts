// Project routes (docs/contracts.md#rest). The route builds ProjectSummary/ProjectDetail from the projects service plus
// session counts, activity and the sync status, which other modules own.
import type { ProjectDetail, ProjectSummary } from "@odin/shared/api";
import { HttpError, readJson, send } from "../http/util.ts";
import type { RegisterRoutes, Services } from "../services.ts";
import { dirname } from "node:path";
import { browseProjectFolders } from "./folders.ts";

export const registerProjectsRoutes: RegisterRoutes = (router, _deps, services) => {
  router.post("/api/project-folders", async ({ req }) => {
    const body = await readJson(req);
    const existing = services.projects.list().find(p => !services.projects.detail(p.name)?.missing);
    return browseProjectFolders(body?.path, existing ? dirname(existing.path) : undefined);
  });
  const detail = (name: string): ProjectDetail => {
    const base = services.projects.detail(name);
    if (!base) throw new HttpError(404, `unknown project "${name}"`);
    return { ...base, ...foreign(services, name), ...sessionSpan(services, name) };
  };
  // The list leaves out the session span: it would read every project's sessions.
  const summaryOf = (name: string): Omit<ProjectDetail, "firstSessionAt" | "lastSessionAt"> => {
    const base = services.projects.detail(name);
    if (!base) throw new HttpError(404, `unknown project "${name}"`);
    return { ...base, ...foreign(services, name) };
  };

  router.get("/api/projects", () =>
    services.projects.list().map((ref): ProjectSummary => {
      const d = summaryOf(ref.name);
      return {
        name: d.name, title: d.title, description: d.description, path: d.path, repo: d.repo, missing: d.missing,
        sessions: d.sessions, sync: d.sync, activity: d.activity, updatedAt: d.updatedAt,
      };
    }),
  );

  router.post("/api/projects", async ({ req, res }) => {
    const body = await readJson(req);
    const ref = await services.projects.create(body);
    // Import the harness's existing sessions for it; a failure here never fails the registration.
    try {
      void Promise.resolve(services.sessions.discover(ref.name)).catch(() => {});
    } catch {
      // discover threw synchronously: ignore
    }
    send(res, 201, detail(ref.name));
  });

  router.get("/api/projects/:name", ({ params }) => detail(params.name!));

  router.patch("/api/projects/:name/settings", async ({ req, params }) => {
    const body = await readJson(req);
    await services.projects.updateSettings(params.name!, body);
    return detail(params.name!);
  });

  router.patch("/api/projects/:name/sources", async ({ req, params }) => {
    const body = await readJson(req);
    if (body !== null && (typeof body !== "object" || Array.isArray(body))) throw new HttpError(400, "expected a sources object or null");
    await services.projects.updateSources(params.name!, body);
    return detail(params.name!);
  });

  router.post("/api/projects/:name/refresh", async ({ params }) => {
    await services.projects.refresh(params.name!);
  });

  router.get("/api/projects/:name/branches", ({ params }) => services.projects.branches(params.name!));

  router.delete("/api/projects/:name/worktrees", async ({ req, res, params }) => {
    const body = await readJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.path !== "string") throw new HttpError(400, "path is required");
    await services.projects.removeWorktree(params.name!, body.path);
    send(res, 204);
  });

  router.delete("/api/projects/:name", ({ params }) => {
    services.projects.remove(params.name!);
  });
};

function foreign(services: Services, name: string): Pick<ProjectDetail, "sessions" | "sync" | "activity"> {
  let activity: number[];
  try {
    activity = services.metrics.sessionsPerDay(name, 14);
  } catch (err) {
    // A failed activity read never breaks the project list.
    console.error(`project ${name}: activity failed:`, err instanceof Error ? err.message : err);
    activity = new Array<number>(14).fill(0);
  }
  return { sessions: services.sessions.counts(name), sync: services.sync.status(name), activity };
}

/** Earliest createdAt and latest updatedAt of the sessions `sessions.counts` counts (not archived, not side threads). */
function sessionSpan(services: Services, name: string): Pick<ProjectDetail, "firstSessionAt" | "lastSessionAt"> {
  const sessions = services.sessions.list({ project: name, archived: false, limit: 1_000_000 });
  let first: string | null = null, last: string | null = null;
  for (const s of sessions) {
    if (first === null || Date.parse(s.createdAt) < Date.parse(first)) first = s.createdAt;
    if (last === null || Date.parse(s.updatedAt) > Date.parse(last)) last = s.updatedAt;
  }
  return { firstSessionAt: first, lastSessionAt: last };
}
