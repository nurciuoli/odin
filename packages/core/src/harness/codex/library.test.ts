import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { setup, PROJECT } from "../../sessions/test-setup.ts";
import { adaptLibrary } from "./library.ts";

test("shared library projects agents into native roles and skills into native resources, honoring project drift", async () => {
  const s = setup();
  try {
    const library = s.services.library;
    library.save("agent", "review", {
      "review.md":
        "---\nname: review\ndescription: Review code\ntools: Read, Grep, Bash\n---\nReview carefully.",
    });
    library.save("skill", "check", {
      "SKILL.md": "---\nname: check\ndescription: Run checks\n---\nRun the checks.",
    });
    library.save("skill", "testing", {
      "SKILL.md":
        "---\nname: testing\ndescription: Test code\n---\nRead helpers.md",
      "helpers.md": "Use fixtures.",
    });
    for (const [kind, id] of [
      ["agent", "review"],
      ["skill", "check"],
      ["skill", "testing"],
    ] as const)
      await library.install(PROJECT, { kind, id, action: "install" });
    const native = adaptLibrary(
      s.services,
      s.deps.config.home,
      PROJECT,
      { cwd: s.projectPath },
      (value) => value,
    );
    assert.doesNotMatch(native.instructions, /Review carefully/);
    const role = readFileSync(native.config.agents.review.config_file, "utf8");
    assert.match(role, /sandbox_mode = "read-only"/);
    assert.match(role, /developer_instructions/);
    assert.equal(native.skills.length, 2);
    const command = native.skills.find((skill) => skill.name === "check")!;
    assert.match(readFileSync(command.path, "utf8"), /name: check/);
    const skill = native.skills.find((skill) => skill.name === "testing")!;
    assert.equal(
      readFileSync(`${dirname(skill.path)}/helpers.md`, "utf8"),
      "Use fixtures.",
    );
    assert.equal(library.get("skill", "check")!.error, null);
  } finally {
    await s.sessions.close();
    s.deps.db.close();
    rmSync(dirname(s.deps.config.home), { recursive: true, force: true });
  }
});

test("shared settings require an explicit native policy and use the installed version", async () => {
  const s = setup();
  try {
    const library = s.services.library;
    library.save("settings", "safe", {
      "safe.json": JSON.stringify({
        name: "Safe",
        permissions: { deny: ["Bash(rm:*)"] },
      }),
    });
    await library.install(PROJECT, {
      kind: "settings",
      id: "safe",
      action: "install",
    });
    assert.throws(
      () =>
        adaptLibrary(
          s.services,
          s.deps.config.home,
          PROJECT,
          { cwd: s.projectPath },
          (value) => value,
        ),
      /native Codex policy/,
    );
    library.save("settings", "safe", {
      "safe.json": JSON.stringify({
        name: "Safe",
        permissions: { deny: ["Bash(rm:*)"] },
        codex: { permissionMode: "plan", instructions: "Inspect only." },
      }),
    });
    // Central edits don't silently change the installed native policy.
    assert.throws(
      () =>
        adaptLibrary(
          s.services,
          s.deps.config.home,
          PROJECT,
          { cwd: s.projectPath },
          (value) => value,
        ),
      /native Codex policy/,
    );
    await library.install(PROJECT, {
      kind: "settings",
      id: "safe",
      action: "update",
    });
    const native = adaptLibrary(
      s.services,
      s.deps.config.home,
      PROJECT,
      { cwd: s.projectPath },
      (value) => value,
    );
    assert.equal(native.permissionMode, "plan");
    assert.match(native.instructions, /Inspect only/);
    await library.install(PROJECT, {
      kind: "settings",
      id: "safe",
      action: "push",
    });
    assert.equal(
      (
        library.get("settings", "safe")!.meta.codex as {
          permissionMode: string;
        }
      ).permissionMode,
      "plan",
    );
  } finally {
    await s.sessions.close();
    s.deps.db.close();
    rmSync(dirname(s.deps.config.home), { recursive: true, force: true });
  }
});
