import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { Router } from "../http/router.ts";
import { HttpError } from "../http/util.ts";
import type { Deps, Services } from "../services.ts";
import { registerNotebookEnvironmentRoutes } from "./environment-routes.ts";

test("notebook environment routes reject invalid request fields and foreign kernel IDs before discovery", async () => {
  const router = new Router();
  const projectsChecked: string[] = [];
  registerNotebookEnvironmentRoutes(router, {} as Deps, {
    projects: { get: () => ({ path: "/project" }) },
    notebooks: { list(project: string) { projectsChecked.push(project); return []; } },
  } as unknown as Services);
  const url = new URL("http://localhost/api/projects/research/notebook-environment/detect");
  const route = router.match("POST", url.pathname);
  assert.equal(route.kind, "found");
  const send = async (data: unknown) => await route.handler({
    url, params: route.params,
    req: Readable.from([Buffer.from(JSON.stringify(data))]) as IncomingMessage,
    res: undefined as never,
  });
  const status = (expected: number) => (error: unknown) => error instanceof HttpError && error.status === expected;
  for (const invalid of [null, [], { hint: null }, { hint: { displayName: ["quant"] } }, { hint: { name: "bad\nname" } },
    { interpreter: "relative/python" }, { interpreter: ["python"] }, { location: { kind: "wsl", distro: "--shell unsafe" } }, { kernelId: "../foreign" }]) {
    await assert.rejects(send(invalid), status(400));
  }
  assert.deepEqual(projectsChecked, []);
  await assert.rejects(send({ kernelId: "other-project-kernel" }), status(404));
  assert.deepEqual(projectsChecked, ["research"]);
});
