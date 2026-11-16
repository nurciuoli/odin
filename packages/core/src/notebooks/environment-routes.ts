import type { KernelLocation } from "@odin/shared/notebooks";
import type { RegisterRoutes } from "../services.ts";
import { HttpError, readJson } from "../http/util.ts";
import { detectNotebookEnvironment, provisionNotebookEnvironment } from "./environment.ts";

export const registerNotebookEnvironmentRoutes: RegisterRoutes = (router, deps, services) => {
  const active = new Set<string>();
  for (const action of ["detect", "setup"] as const) {
    router.post(`/api/projects/:name/notebook-environment/${action}`, async ({ params, req }) => {
      const project = services.projects.get(params.name);
      if (!project) throw new HttpError(404, "unknown project");
      const body = await readJson(req) as { location?: KernelLocation };
      const location = body?.location ?? { kind: "native" };
      if (!location || !["native", "wsl"].includes(location.kind) || (location.kind === "wsl" && (typeof location.distro !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(location.distro)))) throw new HttpError(400, "invalid execution location");
      const key = `${params.name}:${JSON.stringify(location)}`;
      if (active.has(key)) throw new HttpError(409, "Notebook environment setup is already running");
      const options = { home: deps.config.home, cwd: project.path, location };
      try {
        if (action === "setup") active.add(key);
        return await (action === "setup" ? provisionNotebookEnvironment(options) : detectNotebookEnvironment(options));
      } catch { throw new HttpError(502, "Notebook environment setup failed; check Python and uv availability"); }
      finally { if (action === "setup") active.delete(key); }
    });
  }
};
