import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../http/router.ts";
import { HttpError } from "../http/util.ts";
import type { Services } from "../services.ts";
import { stubServices } from "../test-helpers.ts";
import { registerSyncRoutes } from "./routes.ts";
import { syncStack } from "./test-fakes.ts";

function routes(s: ReturnType<typeof syncStack>) {
  const router = new Router();
  const services: Services = stubServices({ projects: s.projects, sync: s.sync });
  registerSyncRoutes(router, s.deps, services);
  return async (method: string, path: string): Promise<unknown> => {
    const url = new URL(path, "http://127.0.0.1");
    const m = router.match(method, url.pathname);
    if (m.kind !== "found") throw new HttpError(m.kind === "not_found" ? 404 : 405, m.kind);
    return m.handler({ req: {} as any, res: {} as any, url, params: m.params });
  };
}

const status = (n: number) => (e: unknown) => e instanceof HttpError && e.status === n;

test("POST sync: 204 after the run, 409 when off, 404 unknown, 502 with a scrubbed error", async () => {
  const s = syncStack();
  const off = syncStack({ repo: null });
  try {
    s.projects.get("odin")!.settings.githubEnabled = true;
    const call = routes(s);
    s.gh.addIssue({ title: "remote" });
    assert.equal(await call("POST", "/api/projects/odin/sync"), undefined);
    assert.ok(s.gh.requests.every((r) => !String(r.url).includes("/issues")));
    await assert.rejects(call("POST", "/api/projects/nope/sync"), status(404));
    await assert.rejects(routes(off)("POST", "/api/projects/odin/sync"), status(409));

    s.gh.failWith = { status: 500, message: `bad ${s.gh.token}` };
    await assert.rejects(call("POST", "/api/projects/odin/sync"), (e: unknown) => status(502)(e) && !(e as Error).message.includes(s.gh.token));
  } finally {
    await Promise.all([s.close(), off.close()]);
  }
});
