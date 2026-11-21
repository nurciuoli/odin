import { posix, resolve, win32 } from "node:path";
import type { KernelLocation, NotebookEnvironmentRequest, NotebookKernelHint } from "@odin/shared/notebooks";
import type { RegisterRoutes } from "../services.ts";
import { HttpError, readJson } from "../http/util.ts";
import { chooseNotebookLocation, detectNotebookEnvironment, listNotebookLocations, provisionNotebookEnvironment, type NotebookEnvironment } from "./environment.ts";

const controlCharacters = /[\u0000-\u001f\u007f]/;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requestLocation(value: unknown): KernelLocation | undefined {
  if (value === undefined) return undefined;
  if (record(value) && value.kind === "native") return { kind: "native" };
  if (record(value) && value.kind === "wsl" && typeof value.distro === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value.distro)) return { kind: "wsl", distro: value.distro };
  throw new HttpError(400, "invalid execution location");
}

function requestHint(value: unknown): NotebookKernelHint | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new HttpError(400, "invalid notebook kernel hint");
  const hint: NotebookKernelHint = {};
  for (const key of ["name", "displayName"] as const) {
    const text = value[key];
    if (text === undefined) continue;
    if (typeof text !== "string" || text.length > 120 || controlCharacters.test(text)) throw new HttpError(400, "invalid notebook kernel hint");
    if (text.trim()) hint[key] = text.trim();
  }
  return hint;
}

export const registerNotebookEnvironmentRoutes: RegisterRoutes = (router, deps, services) => {
  /** Joining identical requests and serializing setup by location also protects the shared host venv. */
  const active = new Map<string, Promise<NotebookEnvironment>>();
  const setupQueue = new Map<string, Promise<NotebookEnvironment>>();
  for (const action of ["detect", "setup"] as const) {
    router.post(`/api/projects/:name/notebook-environment/${action}`, async ({ params, req }) => {
      const project = services.projects.get(params.name);
      if (!project) throw new HttpError(404, "unknown project");
      const raw = await readJson(req) as unknown;
      if (!record(raw)) throw new HttpError(400, "notebook environment request must be an object");
      const requested = requestLocation(raw.location);
      const hint = requestHint(raw.hint);
      if (raw.kernelId !== undefined && (typeof raw.kernelId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(raw.kernelId))) throw new HttpError(400, "invalid notebook kernel id");
      if (raw.interpreter !== undefined && (typeof raw.interpreter !== "string" || !raw.interpreter.trim() || controlCharacters.test(raw.interpreter) || raw.interpreter.length > 4096)) throw new HttpError(400, "invalid Python interpreter");
      const { kernelId, interpreter } = raw as Pick<NotebookEnvironmentRequest, "kernelId" | "interpreter">;
      if (interpreter !== undefined && !posix.isAbsolute(interpreter) && !win32.isAbsolute(interpreter)) throw new HttpError(400, "Python interpreter must be an absolute path in the selected location");
      const kernel = kernelId === undefined ? undefined : services.notebooks.list(params.name).find(candidate => candidate.id === kernelId);
      if (kernelId && !kernel) throw new HttpError(404, "unknown notebook kernel in this project");
      const cwd = kernel?.cwd ?? project.path;
      const projectRoot = kernel ? resolve(kernel.cwd, ...kernel.path.split("/").slice(0, -1).map(() => "..")) : project.path;
      const base = { home: deps.config.home, cwd, projectRoot, hint: hint ?? kernel?.kernelHint };
      try {
        const location = await chooseNotebookLocation({ ...base, location: requested ?? (kernel?.interpreter ? kernel.location : undefined) });
        const absolute = location.kind === "wsl" || process.platform !== "win32" ? posix.isAbsolute : win32.isAbsolute;
        if (interpreter !== undefined && !absolute(interpreter)) throw new HttpError(400, "Python interpreter must be an absolute path in the selected location");
        const options = { ...base, location, discover: true, probe: true, interpreter };
        if (action === "detect") {
          const [environment, locations] = await Promise.all([detectNotebookEnvironment(options), listNotebookLocations()]);
          return { ...environment, locations };
        }
        if (!options.interpreter && kernel?.interpreter && location.kind === kernel.location.kind &&
          (location.kind === "native" || (kernel.location.kind === "wsl" && location.distro === kernel.location.distro))) options.interpreter = kernel.interpreter;
        const locationKey = location.kind === "wsl" ? `wsl:${location.distro}` : "native";
        const key = JSON.stringify([projectRoot, cwd, locationKey, options.interpreter, options.hint]);
        const running = active.get(key);
        if (running) return await running;
        const job = (setupQueue.get(locationKey)?.catch(() => undefined) ?? Promise.resolve()).then(() => provisionNotebookEnvironment(options));
        active.set(key, job);
        setupQueue.set(locationKey, job);
        try { return await job; } finally {
          active.delete(key);
          if (setupQueue.get(locationKey) === job) setupQueue.delete(locationKey);
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(502, error instanceof Error && error.message ? error.message : "Notebook environment request failed");
      }
    });
  }
};
