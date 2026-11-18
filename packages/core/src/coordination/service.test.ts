// Coordinator and threads through the real app (startApp): a temp git repo, real projects/worktrees/sessions, and a
// scripted fake harness that plays the coordinator and the threads. No network, temp dirs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectBrief, ProjectThreads, Session, SessionDetail } from "@odin/shared/api";
import type { TranscriptEntry } from "@odin/shared/harness";
import { fakeHarness, type FakeScript, type FakeStep } from "../harness/fake.ts";
import { startApp, type TestApp } from "../test-helpers.ts";
import { MAX_ACTIVE_THREADS } from "./service.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function tempRepo(): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "odin-coord-"));
  const path = join(root, "demo");
  mkdirSync(path);
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "README.md"), "# demo\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const isCoordinator = (o: { instructions?: string }) => !!o.instructions?.includes("Odin coordinator instructions");
const isThread = (o: { instructions?: string }) => !!o.instructions?.includes("Odin thread instructions");
const toolNames = (o: { hostTools?: { name: string }[] }) => (o.hostTools ?? []).map((t) => t.name);
const userTexts = (entries: TranscriptEntry[] | null) => (entries ?? []).filter((e) => e.kind === "user").map((e) => (e as { text: string }).text);

async function withApp(script: FakeScript, run: (app: TestApp, harness: ReturnType<typeof fakeHarness>) => Promise<void>) {
  const repo = tempRepo();
  const harness = fakeHarness({ script });
  const app = await startApp({ harnesses: { claude: harness } });
  try {
    const created = await app.api("/api/projects", { method: "POST", body: JSON.stringify({ path: repo.path }) });
    assert.equal(created.status, 201);
    await run(app, harness);
  } finally {
    await app.close();
    repo.cleanup();
  }
}

const put = (app: TestApp, path: string, body: unknown) => app.api(path, { method: "PUT", body: JSON.stringify(body) });
const post = (app: TestApp, path: string, body: unknown) => app.api(path, { method: "POST", body: JSON.stringify(body) });

test("a coordinator starts threads that share the brief and memory, and threads report back", async () => {
  const script: FakeScript = (message, turn, options) => {
    if (isCoordinator(options)) {
      if (turn === 0) {
        return [
          { hostTool: "start_thread", input: { task: "Fix bug A in checkout", title: "Bug A" } },
          { hostTool: "start_thread", input: { task: "Investigate bug B", worktree: false } },
          { text: "Started two threads." },
        ];
      }
      return [{ text: `noted: ${message.text.slice(0, 30)}` }];
    }
    if (message.text.includes("bug B")) return [{ fail: "boom" }];
    return [
      { hostTool: "memory_write", input: { path: "pitfalls/checkout.md", content: "Checkout tests need a seeded cart.\n" } },
      { text: "Fixed bug A; tests pass." },
    ];
  };
  await withApp(script, async (app, harness) => {
    assert.equal((await put(app, "/api/projects/demo/brief", { instructions: "Target main. Run yarn test." })).status, 200);
    assert.equal((await put(app, "/api/projects/demo/memory", { path: "MEMORY.md", content: "- pitfalls/: known traps\n" })).status, 200);

    const res = await post(app, "/api/projects/demo/coordinators", { prompt: { text: "Fix the checkout bugs" } });
    assert.equal(res.status, 200);
    const coordinator = (await res.json()) as Session;
    assert.ok(coordinator.tags.includes("coordinator"));

    let threads: ProjectThreads = { coordinators: [] };
    await until(async () => {
      threads = await app.json<ProjectThreads>("/api/projects/demo/threads");
      return threads.coordinators[0]?.threads.length === 2;
    }, "two threads");
    const [b, a] = threads.coordinators[0]!.threads; // newest first
    assert.equal(threads.coordinators[0]!.session.id, coordinator.id);
    assert.equal(a!.task, "Fix bug A in checkout");
    assert.equal(a!.session.title, "Bug A");
    assert.equal(a!.session.workspace.kind, "worktree");
    assert.equal(b!.session.workspace.kind, "checkout");
    assert.ok(a!.session.tags.includes("thread"));

    // Roles: tools and instructions at start.
    const coordStart = harness.starts.find(isCoordinator)!;
    assert.ok(toolNames(coordStart).includes("start_thread"));
    assert.ok(toolNames(coordStart).includes("memory_write"));
    assert.ok(coordStart.instructions!.includes("Target main. Run yarn test."));
    const threadStart = harness.starts.find((o) => isThread(o) && o.sessionId === a!.sessionId)!;
    assert.deepEqual(toolNames(threadStart).filter((n) => n.startsWith("memory_") || n.endsWith("_thread")).sort(), ["memory_delete", "memory_list", "memory_read", "memory_write"]);
    assert.ok(threadStart.instructions!.includes("Target main. Run yarn test."));
    assert.ok(threadStart.instructions!.includes("- pitfalls/: known traps"));

    // The thread's memory write is visible project-wide.
    await until(async () => (await app.json<ProjectBrief>("/api/projects/demo/brief")).memory.some((f) => f.path === "pitfalls/checkout.md"), "memory write");
    assert.equal((await app.json<{ content: string }>("/api/projects/demo/memory?path=pitfalls/checkout.md")).content, "Checkout tests need a seeded cart.\n");

    // Both outcomes reach the coordinator as update messages.
    await until(() => {
      const texts = userTexts(harness.stored(coordinator.id));
      return texts.some((t) => t.includes("finished a turn") && t.includes("Fixed bug A; tests pass.")) && texts.some((t) => t.includes("failed: boom"));
    }, "thread updates in the coordinator");
    const update = userTexts(harness.stored(coordinator.id)).find((t) => t.includes("finished a turn"))!;
    assert.match(update, /^\[Odin thread update\] "Bug A" \(thread [0-9a-f-]+\) finished a turn on branch /);
  });
});

test("ordinary sessions get no coordination tools; a coordinator only reaches its own threads", async () => {
  let other = "";
  const script: FakeScript = (message, _turn, options) => {
    if (isCoordinator(options)) {
      return [
        { hostTool: "read_thread", input: { thread_id: other } },
        { hostTool: "message_thread", input: { thread_id: "nope", message: "hi" } },
        { text: "done" },
      ];
    }
    return [{ text: `ok: ${message.text}` }];
  };
  await withApp(script, async (app, harness) => {
    const plain = (await (await post(app, "/api/sessions", { project: "demo", prompt: { text: "hello" } })).json()) as Session;
    other = plain.id;
    const plainStart = harness.starts.find((o) => o.sessionId === plain.id)!;
    assert.ok(!toolNames(plainStart).some((n) => n.endsWith("_thread") || n.startsWith("memory_")));
    assert.ok(!isCoordinator(plainStart) && !isThread(plainStart));

    const coordinator = (await (await post(app, "/api/projects/demo/coordinators", { prompt: { text: "go" } })).json()) as Session;
    await until(async () => (await app.json<SessionDetail>(`/api/sessions/${coordinator.id}`)).state === "idle", "coordinator idle");
    const tools = (harness.stored(coordinator.id) ?? []).filter((e): e is Extract<TranscriptEntry, { kind: "tool" }> => e.kind === "tool");
    assert.equal(tools.length, 2);
    for (const t of tools) {
      assert.equal(t.result?.ok, false, t.name);
      assert.match(t.result?.text ?? "", /not one of this coordinator's threads/);
    }
    // The plain session got no message.
    assert.deepEqual(userTexts(harness.stored(plain.id)), ["hello"]);
  });
});

test(`a coordinator runs at most ${MAX_ACTIVE_THREADS} threads at once`, async () => {
  const script: FakeScript = (_message, turn, options) => {
    if (isCoordinator(options)) {
      if (turn > 0) return [{ text: "ok" }];
      const steps: FakeStep[] = [];
      for (let i = 0; i <= MAX_ACTIVE_THREADS; i++) steps.push({ hostTool: "start_thread", input: { task: `task ${i}`, worktree: false } });
      return [...steps, { text: "started" }];
    }
    // Threads block on a permission prompt, so they stay `waiting`.
    return [{ tool: "Bash", input: { command: "true" }, ask: true }];
  };
  await withApp(script, async (app, harness) => {
    const coordinator = (await (await post(app, "/api/projects/demo/coordinators", { prompt: { text: "go" } })).json()) as Session;
    await until(async () => (await app.json<SessionDetail>(`/api/sessions/${coordinator.id}`)).state === "idle", "coordinator idle");
    const threads = await app.json<ProjectThreads>("/api/projects/demo/threads");
    assert.equal(threads.coordinators[0]!.threads.length, MAX_ACTIVE_THREADS);
    const last = (harness.stored(coordinator.id) ?? []).filter((e): e is Extract<TranscriptEntry, { kind: "tool" }> => e.kind === "tool").at(-1)!;
    assert.equal(last.result?.ok, false);
    assert.match(last.result?.text ?? "", /limit 6/);
  });
});

test("brief and memory validation", async () => {
  await withApp(() => [{ text: "ok" }], async (app) => {
    assert.equal((await put(app, "/api/projects/demo/brief", { instructions: "x".repeat(16_001) })).status, 400);
    assert.equal((await put(app, "/api/projects/demo/brief", { instructions: 3 })).status, 400);
    for (const path of ["../escape.md", "/abs.md", "notes.txt", "a/../b.md", ".hidden.md", "a//b.md"]) {
      assert.equal((await put(app, "/api/projects/demo/memory", { path, content: "x" })).status, 400, path);
    }
    assert.equal((await put(app, "/api/projects/demo/memory", { path: "big.md", content: "x".repeat(64 * 1024 + 1) })).status, 400);
    assert.equal((await app.api("/api/projects/demo/memory?path=missing.md")).status, 404);
    assert.equal((await app.api("/api/projects/nope/brief")).status, 404);

    const saved = (await (await put(app, "/api/projects/demo/memory", { path: "a/b.md", content: "hi" })).json()) as ProjectBrief;
    assert.deepEqual(saved.memory.map((f) => f.path), ["a/b.md"]);
    assert.equal((await app.api("/api/projects/demo/memory?path=a/b.md", { method: "DELETE" })).status, 204);
    const cleared = (await (await put(app, "/api/projects/demo/brief", { instructions: "  " })).json()) as ProjectBrief;
    assert.deepEqual(cleared, { instructions: "", updatedAt: null, memory: [] });
  });
});
