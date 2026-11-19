// git routes: the same set under /api/sessions/:id/git and /api/projects/:name/git. docs/contracts.md#git.
import type { GitTarget } from "@odin/shared/git";
import { HttpError, readJson } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";

export const registerGitRoutes: RegisterRoutes = (router, _deps, services) => {
  const { git } = services;
  const bases: { prefix: string; param: string; kind: GitTarget["kind"] }[] = [
    { prefix: "/api/sessions/:id/git", param: "id", kind: "session" },
    { prefix: "/api/projects/:name/git", param: "name", kind: "project" },
  ];
  for (const { prefix, param, kind } of bases) {
    const target = (params: Record<string, string | undefined>): GitTarget => ({ kind, id: params[param]! });
    const body = async (req: Parameters<typeof readJson>[0]) => {
      const b = await readJson(req);
      if (b !== undefined && b !== null && (typeof b !== "object" || Array.isArray(b))) throw new HttpError(400, "expected a JSON object");
      return b ?? {};
    };
    router.get(`${prefix}/status`, ({ params }) => git.status(target(params)));
    router.get(`${prefix}/diff`, ({ params, url }) => git.diff(target(params), url.searchParams.get("path") ?? "", url.searchParams.get("staged") === "1"));
    router.post(`${prefix}/stage`, async ({ req, params }) => git.stage(target(params), await body(req)));
    router.post(`${prefix}/unstage`, async ({ req, params }) => git.unstage(target(params), await body(req)));
    router.post(`${prefix}/discard`, async ({ req, params }) => git.discard(target(params), await body(req)));
    router.post(`${prefix}/commit`, async ({ req, params }) => git.commit(target(params), await body(req)));
    router.get(`${prefix}/log`, ({ params, url }) => {
      const q = url.searchParams;
      return git.log(target(params), { path: q.get("path") ?? undefined, ref: q.get("ref") ?? undefined, limit: Number(q.get("limit")) || undefined, skip: Number(q.get("skip")) || undefined });
    });
    router.get(`${prefix}/show`, ({ params, url }) => git.show(target(params), url.searchParams.get("sha") ?? "", url.searchParams.get("path") ?? undefined));
    router.get(`${prefix}/blame`, ({ params, url }) => git.blame(target(params), url.searchParams.get("path") ?? "", url.searchParams.get("rev") ?? undefined));
    router.get(`${prefix}/branches`, ({ params }) => git.branches(target(params)));
    router.post(`${prefix}/checkout`, async ({ req, params }) => git.checkout(target(params), await body(req)));
    router.post(`${prefix}/fetch`, ({ params }) => git.fetch(target(params)));
    router.post(`${prefix}/pull`, async ({ req, params }) => git.pull(target(params), await body(req)));
    router.post(`${prefix}/push`, async ({ req, params }) => git.push(target(params), await body(req)));
    router.get(`${prefix}/stashes`, ({ params }) => git.stashes(target(params)));
    router.post(`${prefix}/stash`, async ({ req, params }) => git.stash(target(params), await body(req)));
    for (const action of ["apply", "pop", "drop"] as const) {
      router.post(`${prefix}/stash/${action}`, async ({ req, params }) => {
        const b = await body(req) as { ref?: unknown };
        return git.stashAction(target(params), action, typeof b.ref === "string" ? b.ref : "");
      });
    }
  }
};
