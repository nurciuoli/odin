import { test } from "node:test";
import assert from "node:assert/strict";
import type { PermissionMode, Session } from "@odin/shared/api";
import type { PermissionRequest } from "@odin/shared/harness";
import { hostToolApprovals } from "./host-tools.ts";

function fixture(mode: PermissionMode = "default") {
  let executed = 0;
  const prompts: PermissionRequest[] = [];
  const resolved: string[] = [];
  const session = { id: "s", permissionMode: mode } as Session;
  const gate = hostToolApprovals({ session: () => session, request: (_, request) => { prompts.push(request); }, resolved: (_, id) => { resolved.push(id); } });
  const tool = gate.wrap("s", { name: "notebook_execute", description: "Runs Python code", params: {}, effect: "execute", handler: async input => { executed++; return { text: String(input.source) }; } });
  return { gate, tool, prompts, resolved, executed: () => executed, session };
}
test("host execution waits for explicit once approval before entering handler", async () => {
  const f = fixture();
  const result = f.tool.handler({ source: "print(1)" });
  assert.equal(f.executed(), 0);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0]!.defaultToDeny, true);
  f.gate.answer("s", f.prompts[0]!.id, { behavior: "allow", scope: "once" });
  assert.equal((await result).text, "print(1)");
  assert.equal(f.executed(), 1);
  assert.equal(f.resolved.length, 1);
});
test("denied and cancelled approvals never execute; another session cannot answer", async () => {
  const f = fixture();
  const result = f.tool.handler({});
  assert.equal(f.gate.answer("other", f.prompts[0]!.id, { behavior: "allow", scope: "once" }), false);
  f.gate.cancel("s");
  assert.equal((await result).isError, true);
  assert.equal(f.executed(), 0);
});
test("plan and dontAsk refuse execution; acceptEdits still asks for execution", async () => {
  for (const mode of ["plan", "dontAsk"] as const) {
    const f = fixture(mode);
    assert.equal((await f.tool.handler({})).isError, true);
    assert.equal(f.executed(), 0);
    assert.equal(f.prompts.length, 0);
  }
  const f = fixture("acceptEdits");
  const result = f.tool.handler({});
  assert.equal(f.prompts.length, 1);
  f.gate.cancel("s");
  await result;
});
test("bypass executes directly and mode changes revoke an outstanding approval", async () => {
  const bypass = fixture("bypassPermissions");
  await bypass.tool.handler({});
  assert.equal(bypass.executed(), 1);
  assert.equal(bypass.prompts.length, 0);
  const f = fixture();
  const result = f.tool.handler({});
  f.session.permissionMode = "plan";
  f.gate.answer("s", f.prompts[0]!.id, { behavior: "allow", scope: "once" });
  assert.equal((await result).isError, true);
  assert.equal(f.executed(), 0);
});
