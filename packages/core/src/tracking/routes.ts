// GET|POST /api/projects/:name/tracking/claude-code: install or remove the Claude Code hooks in a project
// (docs/contracts.md#claude-code-adapter).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS_RELATIVE_PATH, hooksInstalled, installHooks, removeHooks } from "@odin/adapter-claude-code/install";
import type { ClaudeCodeTrackingStatus } from "@odin/shared/api";
import { HttpError, readJson } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";

export const registerTrackingRoutes: RegisterRoutes = (router, deps, services) => {
  const projectPath = (name: string): string => {
    const project = services.projects.get(name);
    if (!project) throw new HttpError(404, `no project "${name}"`);
    return project.path;
  };
  // config.adapterDir (ODIN_ADAPTER_DIR): a packaged app ships the hook bundled to JavaScript.
  const hookScript = (): string => {
    for (const ext of ["cmd", "js"]) {
      const file = join(deps.config.adapterDir, `odin-hook.${ext}`);
      if (existsSync(file)) return file;
    }
    return join(deps.config.adapterDir, "odin-hook.ts");
  };
  const status = (path: string): ClaudeCodeTrackingStatus => ({ enabled: hooksInstalled(path), settingsPath: SETTINGS_RELATIVE_PATH });

  router.get("/api/projects/:name/tracking/claude-code", ({ params }) => status(projectPath(params.name!)));

  router.post("/api/projects/:name/tracking/claude-code", async ({ req, params }) => {
    const path = projectPath(params.name!);
    const body = await readJson(req);
    if (typeof body?.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    try {
      if (body.enabled) installHooks(path, hookScript());
      else removeHooks(path);
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : "could not update the Claude Code hooks");
    }
    return status(path);
  });
};
