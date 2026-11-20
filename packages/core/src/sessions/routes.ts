// sessions routes: /api/sessions…, /api/projects/:name/discover, /api/models. docs/contracts.md#rest.
import type { SessionFilter, SessionOrigin, SessionState } from "@odin/shared/api";
import { HttpError, readJson, send } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";
import { ORIGINS, SESSION_STATES } from "./service.ts";
import { MESSAGE_BODY_MAX_BYTES } from "./message.ts";

function bool(value: string | null, name: string): boolean | undefined {
  if (value === null || value === "") return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new HttpError(400, `${name} must be true or false`);
}

/** Query string → SessionFilter. `archived` defaults to false. */
export function parseSessionFilter(params: URLSearchParams): SessionFilter {
  const filter: SessionFilter = {};
  const project = params.get("project");
  if (project) filter.project = project;
  const state = params.get("state");
  if (state) {
    const states = state.split(",").map((s) => s.trim()).filter(Boolean);
    for (const s of states) if (!SESSION_STATES.includes(s as SessionState)) throw new HttpError(400, `unknown state ${s}`);
    if (states.length) filter.state = states as SessionState[];
  }
  const tag = params.get("tag");
  if (tag) filter.tag = tag;
  const model = params.get("model");
  if (model) filter.model = model;
  const origin = params.get("origin");
  if (origin) {
    if (!(ORIGINS as readonly string[]).includes(origin)) throw new HttpError(400, `unknown origin ${origin}`);
    filter.origin = origin as SessionOrigin;
  }
  const q = params.get("q");
  if (q && q.trim()) filter.q = q.trim();
  filter.archived = bool(params.get("archived"), "archived") ?? false;
  const pinned = bool(params.get("pinned"), "pinned");
  if (pinned !== undefined) filter.pinned = pinned;
  const aside = bool(params.get("aside"), "aside");
  if (aside !== undefined) filter.aside = aside;
  const parentId = params.get("parentId");
  if (parentId) filter.parentId = parentId;
  const since = params.get("since");
  if (since) {
    if (Number.isNaN(Date.parse(since))) throw new HttpError(400, "since must be an ISO date");
    filter.since = since;
  }
  const limit = params.get("limit");
  if (limit) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "limit must be a positive integer");
    filter.limit = Math.min(n, 1000);
  }
  return filter;
}

export const registerSessionsRoutes: RegisterRoutes = (router, deps, services) => {
  const { sessions } = services;

  router.get("/api/sessions", ({ url }) => sessions.list(parseSessionFilter(url.searchParams)));

  router.post("/api/sessions", async ({ req, res }) => {
    const session = await sessions.start(await readJson(req, MESSAGE_BODY_MAX_BYTES));
    send(res, 201, session);
  });

  router.get("/api/sessions/:id", async ({ params }) => {
    const detail = await sessions.detail(params.id!);
    if (!detail) throw new HttpError(404, `unknown session ${params.id}`);
    return detail;
  });

  router.patch("/api/sessions/:id", async ({ req, params }) => sessions.update(params.id!, await readJson(req)));
  router.get("/api/sessions/:id/native", ({ params }) => sessions.nativeState(params.id!));
  router.post("/api/sessions/:id/native", async ({ req, params }) => sessions.nativeAction(params.id!, await readJson(req)));
  router.get("/api/harnesses/:id/native", async ({ params, url }) => {
    const harness = deps.harnesses[params.id!];
    if (!harness?.nativeCatalog) throw new HttpError(400, "runtime does not provide native resources");
    const project = services.projects.get(url.searchParams.get("project") ?? "");
    if (!project) throw new HttpError(404, "unknown project");
    if (project.missing) throw new HttpError(409, "project is missing on disk");
    return harness.nativeCatalog(project.path);
  });

  router.get("/api/sessions/:id/tasks/:taskKey", async ({ params }) => sessions.taskMessages(params.id!, params.taskKey!));
  router.get("/api/sessions/:id/attachments/:entryId/:index", async ({ res, params }) => {
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 0) throw new HttpError(400, "index must be a non-negative integer");
    const file = await sessions.readAttachment(params.id!, params.entryId!, index);
    if (!file) throw new HttpError(404, "unknown attachment");
    res.writeHead(200, {
      "content-type": file.mediaType,
      "content-length": file.body.length,
      "content-disposition": file.disposition,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    }).end(file.body);
  });

  router.delete("/api/sessions/:id", async ({ params }) => {
    await sessions.remove(params.id!);
  });

  router.post("/api/sessions/:id/messages", async ({ req, params }) => sessions.send(params.id!, await readJson(req, MESSAGE_BODY_MAX_BYTES)));
  router.post("/api/sessions/:id/shell", async ({ req, params }) => sessions.shell(params.id!, await readJson(req, 16 * 1024)));
  router.get("/api/sessions/:id/queue", ({ params }) => sessions.queue(params.id!));
  router.patch("/api/sessions/:id/queue/:messageId", async ({ req, params }) => sessions.editQueuedMessage(params.id!, params.messageId!, await readJson(req, MESSAGE_BODY_MAX_BYTES)));
  router.delete("/api/sessions/:id/queue/:messageId", ({ params }) => sessions.cancelQueuedMessage(params.id!, params.messageId!));
  router.post("/api/sessions/:id/queue/resume", ({ params }) => sessions.resumeQueue(params.id!));
  router.post("/api/sessions/:id/queue/send-now", async ({ req, params }) => {
    const body = await readJson(req, MESSAGE_BODY_MAX_BYTES);
    return sessions.sendNow(params.id!, body && typeof body.text === "string" ? body : undefined);
  });
  router.post("/api/sessions/:id/queue/:messageId/retry", ({ params }) => sessions.retryQueuedMessage(params.id!, params.messageId!));

  router.post("/api/sessions/:id/permissions/:requestId", async ({ req, params }) => {
    sessions.answer(params.id!, params.requestId!, await readJson(req));
  });

  router.post("/api/sessions/:id/interrupt", async ({ params }) => {
    await sessions.interrupt(params.id!);
  });

  router.post("/api/sessions/:id/end", async ({ params }) => sessions.end(params.id!));

  router.post("/api/sessions/:id/fork", async ({ req, res, params }) => {
    const session = await sessions.fork(params.id!, await readJson(req, MESSAGE_BODY_MAX_BYTES));
    send(res, 201, session);
  });

  router.get("/api/sessions/:id/handoff", ({ params, url }) => sessions.handoffPreview(params.id!, url.searchParams.get("harness") ?? ""));
  router.post("/api/sessions/:id/handoff", async ({ req, res, params }) => {
    send(res, 201, await sessions.handoff(params.id!, await readJson(req, MESSAGE_BODY_MAX_BYTES)));
  });

  router.post("/api/projects/:name/discover", async ({ params }) => ({ added: await sessions.discover(params.name!) }));

  router.get("/api/models", async ({ url }) => {
    const id = url.searchParams.get("harness") || "claude";
    const harness = deps.harnesses[id];
    if (!harness) throw new HttpError(400, `unknown harness ${id}`);
    return harness.models();
  });
};
