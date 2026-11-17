import type { RegisterRoutes } from "../services.ts";
import type { OpenNotebookRequest, ExecuteCellRequest, NotebookCell } from "@odin/shared/notebooks";
import { HttpError, readJson } from "../http/util.ts";

export const registerNotebookRoutes: RegisterRoutes = (router, _deps, services) => {
  router.get("/api/projects/:name/notebooks", ({ params }) => services.notebooks.list(params.name));
  router.post("/api/projects/:name/notebooks/open", async ({ params, req }) => services.notebooks.open(params.name, await readJson(req) as OpenNotebookRequest));
  router.get("/api/notebooks/:id", ({ params }) => services.notebooks.snapshot(params.id));
  router.put("/api/notebooks/:id", async ({ params, req }) => {
    const body = await readJson(req, 16 * 1024 * 1024) as { revision: string; cells: NotebookCell[] };
    if (!body || typeof body.revision !== "string") throw new HttpError(400, "revision is required");
    return services.notebooks.save(params.id, body.revision, body.cells);
  });
  router.get("/api/sessions/:id/notebooks", ({ params }) => services.notebooks.forSession(params.id));
  router.post("/api/sessions/:id/notebooks/:kernelId/attach", ({ params }) => services.notebooks.attach(params.id, params.kernelId));
  router.post("/api/notebooks/:id/execute", async ({ params, req }) => {
    const body = await readJson(req) as ExecuteCellRequest;
    // Human execution is attributed to the user; agents use the permission-gated host tools.
    if (body?.sessionId !== undefined) throw new HttpError(400, "sessionId is reserved for host tools");
    return services.notebooks.execute(params.id, body);
  });
  router.get("/api/notebook-executions/:id", ({ params }) => services.notebooks.execution(params.id));
  router.post("/api/notebook-executions/:id/wait", async ({ params, req }) => {
    const body = await readJson(req) as { timeoutMs?: number };
    return services.notebooks.wait(params.id, body?.timeoutMs);
  });
  router.post("/api/notebooks/:id/interrupt", ({ params }) => services.notebooks.interrupt(params.id));
  router.post("/api/notebooks/:id/stop", ({ params }) => services.notebooks.stop(params.id));
  router.get("/api/notebooks/:id/widgets", ({ params }) => services.notebooks.widgetState(params.id));
  router.post("/api/notebooks/:id/comm", async ({ params, req }) => services.notebooks.sendComm(params.id, await readJson(req) as import("@odin/shared/notebooks").NotebookComm));
  router.delete("/api/notebooks/:id", ({ params }) => services.notebooks.remove(params.id));
  router.post("/api/notebooks/:id/variables", ({ params }) => services.notebooks.variables(params.id));
  router.post("/api/notebooks/:id/dataframe", async ({ params, req }) => {
    const body = await readJson(req) as { name: string; offset?: number; limit?: number; sort?: string; descending?: boolean };
    if (!body || typeof body !== "object") throw new HttpError(400, "dataframe name is required");
    return services.notebooks.dataframe(params.id, body.name, body);
  });
};
