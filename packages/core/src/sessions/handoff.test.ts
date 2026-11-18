import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptEntry } from "@odin/shared/harness";
import { BRIEF_MAX_CHARS, buildBrief, type BriefInput } from "./handoff.ts";
import { fakeHarness } from "../harness/fake.ts";
import { PROJECT, serve, setup, waitFor } from "./test-setup.ts";

const u = (id: string, text: string): TranscriptEntry => ({ kind: "user", id, text, at: null, parentToolUseId: null });
const a = (id: string, text: string): TranscriptEntry => ({ kind: "assistant", id, text, model: null, at: null, parentToolUseId: null });

function input(over: Partial<BriefInput> = {}): BriefInput {
  return {
    sessionId: "s1", title: "Fix the parser", harness: "claude", harnessName: "Claude Code", targetName: "Codex", model: "opus",
    firstPrompt: null, transcript: [], todos: [], branch: "feat/parser", files: [], diffStat: "", ...over,
  };
}

test("the briefing has the task, the last summary, the plan, recent steps and the working tree", () => {
  const brief = buildBrief(input({
    transcript: [
      u("1", "Make the parser accept trailing commas"),
      a("2", "Looking."),
      { kind: "tool", id: "3", name: "Edit", input: { file_path: "src/parser.ts" }, result: { ok: false, text: "boom", truncated: false }, at: null, parentToolUseId: null },
      a("4", "Parser done, tests still red on the lexer."),
      { kind: "assistant", id: "5", text: "subagent chatter", model: null, at: null, parentToolUseId: "t" },
    ],
    todos: [{ content: "parser", status: "completed" }, { content: "lexer", status: "in_progress" }, { content: "docs", status: "pending" }],
    files: ["src/parser.ts", "src/lexer.ts"], diffStat: " src/parser.ts | 4 ++--",
  }));
  assert.equal(brief.truncated, false);
  const t = brief.text;
  assert.match(t, /^# Handoff from Claude Code/);
  assert.match(t, /## Task\n\nMake the parser accept trailing commas/);
  assert.match(t, /## Where it stands[\s\S]*Parser done, tests still red/);
  assert.match(t, /- \[x\] parser\n- \[~\] lexer\n- \[ \] docs/);
  assert.match(t, /- tool: Edit src\/parser\.ts \(failed\)/);
  assert.doesNotMatch(t, /subagent chatter/);
  assert.match(t, /Branch: `feat\/parser`/);
  assert.match(t, /Uncommitted changes \(2\):\n\n- src\/parser\.ts\n- src\/lexer\.ts/);
  assert.match(t, /Session "Fix the parser" on Claude Code \(opus\), Odin session s1\./);
});

test("the briefing falls back to the stored first prompt, says when the tree is clean and cuts long sections", () => {
  const clean = buildBrief(input({ firstPrompt: "do the thing" }));
  assert.match(clean.text, /## Task\n\ndo the thing/);
  assert.match(clean.text, /No uncommitted changes\./);
  const long = buildBrief(input({ transcript: [u("1", "x".repeat(10000))], files: Array.from({ length: 60 }, (_, i) => `f${i}.ts`) }));
  assert.equal(long.truncated, true);
  assert.match(long.text, /\[… cut\]/);
  assert.match(long.text, /… and 20 more/);
  assert.ok(long.text.length <= BRIEF_MAX_CHARS);
});

function twoHarnesses() {
  const codex = fakeHarness({ id: "codex" });
  const s = setup();
  s.deps.harnesses.codex = codex;
  return { s, codex };
}

test("handoff starts the same checkout on another harness with the briefing, links the sessions and ends the source", async () => {
  const { s, codex } = twoHarnesses();
  try {
    const source = await s.sessions.start({ project: PROJECT, prompt: { text: "Add trailing commas" }, model: "m1" });
    await waitFor(() => s.sessions.get(source.id)?.state === "idle");
    const preview = await s.sessions.handoffPreview(source.id, "codex");
    assert.match(preview.brief, /Add trailing commas/);
    assert.equal(preview.target.harness, "codex");
    assert.equal(preview.target.available, true);
    assert.equal(s.sessions.get(source.id)!.state, "idle");

    const next = await s.sessions.handoff(source.id, { harness: "codex" });
    assert.equal(next.harness, "codex");
    assert.equal(next.cwd, source.cwd);
    assert.equal(next.branch, source.branch);
    assert.equal(next.parentId, source.id);
    assert.equal(next.handoff?.from, source.id);
    assert.equal(next.handoff?.harness, "claude");
    assert.equal(codex.starts.length, 1);
    assert.match(codex.starts[0]!.prompt!.text, /# Handoff from/);
    assert.equal(codex.starts[0]!.resume, undefined);
    assert.equal(s.sessions.get(source.id)!.state, "ended");
    assert.equal(s.sessions.get(next.id)!.handoff?.from, source.id);
  } finally { await s.sessions.close(); }
});

test("handoff uses the edited briefing, keeps the source with endSource false and refuses bad requests", async () => {
  const { s, codex } = twoHarnesses();
  try {
    const source = await s.sessions.start({ project: PROJECT, prompt: { text: "work" } });
    await waitFor(() => s.sessions.get(source.id)?.state === "idle");
    await assert.rejects(s.sessions.handoff(source.id, { harness: "claude" }), /different harness/);
    await assert.rejects(s.sessions.handoff(source.id, { harness: "nope" }), /unknown harness/);
    await assert.rejects(s.sessions.handoff(source.id, { harness: "codex", brief: "  " }), /brief/);
    await assert.rejects(s.sessions.handoff(source.id, { harness: "codex", permissionMode: "bogus" as never }), /permission mode/);
    assert.equal(codex.starts.length, 0);
    const next = await s.sessions.handoff(source.id, { harness: "codex", brief: "just do X", title: "Continue", endSource: false });
    assert.equal(codex.starts[0]!.prompt!.text, "just do X");
    assert.equal(next.title, "Continue");
    assert.equal(s.sessions.get(source.id)!.state, "idle");
  } finally { await s.sessions.close(); }
});

test("a running source and an unavailable target are 409; the HTTP routes work", async () => {
  const s = setup({ harness: { script: () => [{ wait: new Promise<void>(() => {}) }] } });
  const codex = fakeHarness({ id: "codex" });
  s.deps.harnesses.codex = codex;
  const app = await serve(s);
  try {
    const running = await (await app.post("/api/sessions", { project: PROJECT, prompt: { text: "go" } })).json();
    assert.equal((await app.post(`/api/sessions/${running.id}/handoff`, { harness: "codex" })).status, 409);
    assert.equal((await app.api(`/api/sessions/${running.id}/handoff?harness=codex`)).status, 200);
    assert.equal((await app.api(`/api/sessions/${running.id}/handoff?harness=claude`)).status, 400);
    assert.equal((await app.api(`/api/sessions/missing/handoff?harness=codex`)).status, 404);
    await app.post(`/api/sessions/${running.id}/end`);
    codex.check = async () => ({ available: false, note: "not installed" });
    const refused = await app.post(`/api/sessions/${running.id}/handoff`, { harness: "codex" });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /not installed/);
    codex.check = async () => ({ available: true, note: null });
    const ok = await app.post(`/api/sessions/${running.id}/handoff`, { harness: "codex" });
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).handoff.from, running.id);
  } finally { await app.close(); }
});
