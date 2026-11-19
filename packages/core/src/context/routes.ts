// Project agent context: global library items plus the files already in the repo.
import type { AgentContextKind } from "@odin/shared/api";
import { AGENT_CONTEXT_KINDS } from "@odin/shared/api";
import { HttpError, readJson } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";

export const registerAgentContextRoutes: RegisterRoutes = (router, _deps, services) => {
  router.get("/api/projects/:name/agent-context", ({ params }) => services.agentContext.get(params.name!));

  router.get("/api/projects/:name/agent-context/:kind/:id", ({ params }) =>
    services.agentContext.files(params.name!, params.kind!, params.id!));

  router.patch("/api/projects/:name/agent-context", async ({ req, params }) => {
    const body = await readJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "expected an object");
    const kind = body.kind;
    if (typeof kind !== "string" || !(AGENT_CONTEXT_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "unknown context kind");
    return services.agentContext.setEnabled(params.name!, {
      kind: kind as AgentContextKind,
      id: typeof body.id === "string" ? body.id : "",
      enabled: body.enabled as boolean,
    });
  });

  router.put("/api/projects/:name/agent-context/:kind/:id", async ({ req, params }) => {
    const body = await readJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body) || !body.files || typeof body.files !== "object" || Array.isArray(body.files)) {
      throw new HttpError(400, "files are required");
    }
    return services.agentContext.write(params.name!, params.kind!, params.id!, body.files as Record<string, string>);
  });

  router.delete("/api/projects/:name/agent-context/:kind/:id", ({ params }) =>
    services.agentContext.remove(params.name!, params.kind!, params.id!));
};
