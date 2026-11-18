import type { KernelLocation } from "@odin/shared/notebooks";
import type { RegisterRoutes } from "../services.ts";
import { HttpError, readJson } from "../http/util.ts";
import { chooseNotebookLocation, detectNotebookEnvironment, provisionNotebookEnvironment, type NotebookEnvironment } from "./environment.ts";

export const registerNotebookEnvironmentRoutes: RegisterRoutes = (router, deps, services) => {
  /** One setup per project at a time; a second click joins the one already running instead of failing. */
  const active = new Map<string, Promise<NotebookEnvironment>>();
  for (const action of ["detect", "setup"] as const) {
    router.post(`/api/projects/:name/notebook-environment/${action}`, async ({ params, req }) => {
      const project = services.projects.get(params.name);
      if (!project) throw new HttpError(404, "unknown project");
      const body = await readJson(req) as { location?: KernelLocation } | null;
      const requested = body?.location;
      if (requested !== undefined && (!requested || !["native", "wsl"].includes(requested.kind) || (requested.kind === "wsl" && (typeof requested.distro !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(requested.distro))))) throw new HttpError(400, "invalid execution location");
      const base = { home: deps.config.home, cwd: project.path };
      try {
        if (action === "detect") return await detectNotebookEnvironment({ ...base, location: await chooseNotebookLocation({ ...base, location: requested }) });
        const key = params.name;
        const running = active.get(key);
        if (running) return await running;
        const job = (async () => provisionNotebookEnvironment({ ...base, location: await chooseNotebookLocation({ ...base, location: requested }) }))();
        active.set(key, job);
        try { return await job; } finally { active.delete(key); }
      } catch (error) { throw new HttpError(502, error instanceof Error && error.message ? error.message : "Notebook environment setup failed"); }
    });
  }
};
