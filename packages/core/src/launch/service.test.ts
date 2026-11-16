import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectAgent, StartSessionRequest, TemplateSpec } from "@odin/shared/api";
import { fakeHarness } from "../harness/fake.ts";
import { HttpError } from "../http/util.ts";
import { PROJECT, setup } from "../sessions/test-setup.ts";
import type { Services } from "../services.ts";
import { DEFAULT_APP_SETTINGS } from "../settings/service.ts";
import { titleFromPrompt, validBranchName } from "./service.ts";

const ID = "0123abcd-0000-4000-8000-000000000000";
const status = (n: number) => (e: unknown) => e instanceof HttpError && e.status === n;
const agent: ProjectAgent = {
  id: "reviewer", name: "reviewer", description: "Reviews", model: null, tools: null, path: ".claude/agents/reviewer.md", version: "v123", libraryId: null, error: null,
};

async function plan(req: Partial<StartSessionRequest>, o: Parameters<typeof setup>[0] = {}) {
  const s = setup(o);
  try {
    return await s.services.launch.plan({ project: PROJECT, ...req } as StartSessionRequest, ID);
  } finally {
    await s.sessions.close();
  }
}

test("grok rejects a Claude or GPT model id", async () => {
  await assert.rejects(
    plan({ prompt: { text: "hi" }, harness: "grok", model: "opus" }, { harnesses: { claude: fakeHarness(), grok: fakeHarness({ id: "grok" }) } }),
    (error: unknown) => error instanceof HttpError && /Choose a Grok model/.test(error.message),
  );
  const accepted = await plan({ prompt: { text: "hi" }, harness: "grok", model: "grok-4.7" }, { harnesses: { claude: fakeHarness(), grok: fakeHarness({ id: "grok" }) } });
  assert.equal(accepted.model, "grok-4.7");
});

test("basic plan: prompt, title from the first line, defaults from settings", async () => {
  const p = await plan({ prompt: { text: "\n  Fix the {{project}} build on {{branch}}\nDetails" } });
  assert.deepEqual(p.prompt, { text: "\n  Fix the demo build on main\nDetails" });
  assert.equal(p.title, "Fix the demo build on main");
  assert.deepEqual([p.model, p.permissionMode, p.worktree, p.branch], [null, "default", false, null]);
  assert.deepEqual([p.mcpServers, p.tags], [{}, []]);
});

test("request fields win; worktree branch from the title and id; variables fill; unknown ones stay", async () => {
  const p = await plan({
    prompt: { text: "Do {{thing}} with {{missing}} and {{constructor}} on {{branch}}", attachments: [{ name: "a.txt", mediaType: "text/plain", data: "hi" }] },
    title: "My Task", model: "opus", permissionMode: "acceptEdits", worktree: true, variables: { thing: "it" }, tags: ["a", "a", "b"],
  });
  assert.equal(p.prompt!.text, "Do it with {{missing}} and {{constructor}} on odin/my-task-0123abcd");
  assert.equal(p.prompt!.attachments!.length, 1);
  assert.deepEqual([p.title, p.model, p.permissionMode, p.branch, p.tags], ["My Task", "opus", "acceptEdits", "odin/my-task-0123abcd", ["a", "b"]]);
  assert.equal((await plan({ prompt: { text: "x" }, worktree: true, branch: "feat/x" })).branch, "feat/x");
});

function fakeLibrary(assets: Record<string, { meta?: Record<string, unknown>; files?: Record<string, string>; error?: string | null; version?: string }>): Services["library"] {
  const find = (kind: string, id: string) => assets[`${kind}/${id}`];
  return {
    get: (kind: string, id: string) => {
      const a = find(kind, id);
      return a ? { kind, id, name: id, description: "", version: a.version ?? "lv1", updatedAt: "", files: Object.keys(a.files ?? {}), meta: a.meta ?? {}, error: a.error ?? null } : null;
    },
    files: (kind: string, id: string) => find(kind, id)?.files ?? null,
  } as unknown as Services["library"];
}

const tpl = (o: Partial<TemplateSpec>): Record<string, unknown> => ({ prompt: "", promptId: null, model: null, permissionMode: null, agent: null, worktree: false, mcp: [], tags: [], ...o });

async function planLib(req: Partial<StartSessionRequest>, assets: Parameters<typeof fakeLibrary>[0], o: Parameters<typeof setup>[0] = {}) {
  const s = setup(o);
  s.services.library = fakeLibrary(assets);
  try {
    return await s.services.launch.plan({ project: PROJECT, ...req } as StartSessionRequest, ID);
  } finally {
    await s.sessions.close();
  }
}

test("MCP ids → servers without name/description; unknown → 400", async () => {
  const assets = {
    "mcp/gh": { meta: { name: "gh", description: "GitHub", type: "stdio", command: "gh-mcp", args: ["--x"], env: { A: "b" } } },
    "mcp/web": { meta: { name: "web", description: "w", type: "http", url: "https://x.test/mcp", headers: { H: "v" } } },
    "mcp/broken": { meta: { name: "b" } },
    "template/t": { meta: tpl({ prompt: "x", mcp: ["web"] }) },
  };
  const p = await planLib({ prompt: { text: "x" }, mcp: ["gh", "web", "gh"] }, assets);
  assert.deepEqual(p.mcpServers, {
    gh: { type: "stdio", command: "gh-mcp", args: ["--x"], env: { A: "b" } },
    web: { type: "http", url: "https://x.test/mcp", headers: { H: "v" } },
  });
  await assert.rejects(planLib({ prompt: { text: "x" }, mcp: ["nope"] }, assets), status(400));
  await assert.rejects(planLib({ prompt: { text: "x" }, mcp: ["broken"] }, assets), status(400));
  await assert.rejects(planLib({ prompt: { text: "x" }, mcp: "gh" as never }, assets), status(400));
});

test("template 400s: unknown template, errors, no prompt, unknown or empty library prompt", async () => {
  const assets = {
    "template/bad": { error: "nope", meta: {} },
    "template/empty": { meta: tpl({}) },
    "template/p": { meta: tpl({ promptId: "missing" }) },
    "template/q": { meta: tpl({ promptId: "blank" }) },
    "prompt/blank": { files: { "blank.md": "---\nname: b\n---\n" } },
  };
  for (const templateId of ["unknown", "bad", "empty", "p", "q"]) await assert.rejects(planLib({ templateId }, assets), status(400), templateId);
});

test("worktree branch comes from the title", async () => {
  const p = await plan({ prompt: { text: "Crash on start" }, worktree: true });
  assert.equal(p.title, "Crash on start");
  assert.match(p.branch!, /^odin\/crash-on-start-/);
});

test("validation: no prompt, bad fields, unknown project", async () => {
  await assert.rejects(plan({}), status(400));
  await assert.rejects(plan({ prompt: { text: "  " } }), status(400));
  await assert.rejects(plan({ prompt: { text: "x" }, permissionMode: "yolo" as never }), status(400));
  await assert.rejects(plan({ prompt: { text: "x" }, branch: "a..b" }), status(400));
  await assert.rejects(plan({ prompt: { text: "x" }, tags: [1] as never }), status(400));
  await assert.rejects(plan({ prompt: { text: "x" }, project: "nope" }), status(404));
});

test("validBranchName and titleFromPrompt", () => {
  for (const ok of ["main", "item/12-fix", "odin/a-b_c.d"]) assert.ok(validBranchName(ok), ok);
  for (const no of ["", "-x", "/x", "x/", "a..b", "a b", "x.lock", "a//b", "a/.b", "a;b", "x."]) assert.ok(!validBranchName(no), no);
  assert.equal(titleFromPrompt("a".repeat(200)).length, 120);
  assert.equal(titleFromPrompt("\n\n  hi  \nthere"), "hi");
});

test("worktree: request ?? project default ?? app default", async () => {
  const run = async (project: boolean | undefined, app: boolean, req: boolean | undefined) => {
    const s = setup();
    try {
      s.services.projects.get(PROJECT)!.settings.defaultWorktree = project;
      s.services.settings.get = () => ({ ...DEFAULT_APP_SETTINGS, defaultWorktree: app });
      return (await s.services.launch.plan({ project: PROJECT, prompt: { text: "x" }, ...(req === undefined ? {} : { worktree: req }) } as StartSessionRequest, ID)).worktree;
    } finally {
      await s.sessions.close();
    }
  };
  assert.equal(await run(undefined, true, undefined), true);
  assert.equal(await run(undefined, false, undefined), false);
  assert.equal(await run(true, false, undefined), true);
  assert.equal(await run(false, true, undefined), false);
  assert.equal(await run(true, false, false), false);
  assert.equal(await run(false, true, true), true);
});
