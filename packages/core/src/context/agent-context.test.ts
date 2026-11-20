import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectAgentContext, ProjectDetail } from "@odin/shared/api";
import { fakeHarness } from "../harness/fake.ts";
import { startApp, tempDir } from "../test-helpers.ts";
import { scanProject } from "./agent-context.ts";

const SKILL = (description: string, body: string) => `---\nname: ship\ndescription: ${description}\n---\n${body}\n`;

test("scan reads skills, agents, MCP servers and instruction files", () => {
  const cwd = tempDir("odin-context-");
  mkdirSync(join(cwd, ".grok", "skills", "ship"), { recursive: true });
  writeFileSync(join(cwd, ".grok", "skills", "ship", "SKILL.md"), SKILL("Ship from grok", "Do the grok one."));
  mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reads diffs.\n---\nBe thorough.\n");
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "docs-mcp", args: ["--x"] } } }));
  writeFileSync(join(cwd, "AGENTS.md"), "Local rules.\n");
  const found = scanProject(cwd);
  assert.equal(found.find((item) => item.kind === "skill" && item.id === "ship")?.root, ".grok/skills");
  assert.equal(found.find((item) => item.kind === "agent" && item.id === "reviewer")?.description, "Reads diffs.");
  assert.equal(found.find((item) => item.kind === "mcp" && item.id === "docs")?.error, null);
  assert.ok(found.some((item) => item.kind === "instruction" && item.id === "agents-md"));
});

test("sessions take global context, let project files win, and a project can turn a global item off", async () => {
  const claude = fakeHarness();
  const grok = fakeHarness();
  const app = await startApp({ harnesses: { claude, grok } });
  const cwd = tempDir("odin-context-app-");
  mkdirSync(join(cwd, ".claude", "skills", "ship"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "skills", "ship", "SKILL.md"), SKILL("Project ship", "Use the project steps."));
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { local: { command: "local-mcp" } } }));
  writeFileSync(join(cwd, "AGENTS.md"), "Project rules.\n");
  try {
    const project = await app.json<ProjectDetail>("/api/projects", { method: "POST", body: JSON.stringify({ path: cwd }) });
    await app.json(`/api/library/skill/ship`, { method: "PUT", body: JSON.stringify({ files: { "SKILL.md": SKILL("Library ship", "Use the library steps.") } }) });
    await app.json(`/api/library/skill/notes`, { method: "PUT", body: JSON.stringify({ files: { "SKILL.md": SKILL("Notes", "Take notes.").replace("name: ship", "name: notes") } }) });
    await app.json(`/api/library/mcp/docs`, { method: "PUT", body: JSON.stringify({ files: { "docs.json": JSON.stringify({ name: "Docs", type: "stdio", command: "docs-mcp" }) } }) });
    await app.json(`/api/library/instruction/global`, { method: "PUT", body: JSON.stringify({ files: { "AGENTS.md": "Global guidance.\n" } }) });

    const listed = await app.json<ProjectAgentContext>(`/api/projects/${project.name}/agent-context`);
    const projectShip = listed.project.find((item) => item.kind === "skill" && item.id === "ship");
    const globalShip = listed.global.find((item) => item.kind === "skill" && item.id === "ship");
    assert.equal(projectShip?.path, ".claude/skills/ship");
    assert.equal(globalShip?.overridden, true);
    assert.equal(listed.global.find((item) => item.id === "notes")?.enabled, true);

    const created = await app.json<ProjectAgentContext>(`/api/projects/${project.name}/agent-context/agent/helper`, {
      method: "PUT",
      body: JSON.stringify({ files: { "helper.md": "---\nname: helper\ndescription: Helps.\n---\nHelp.\n" } }),
    });
    assert.ok(created.project.some((item) => item.kind === "agent" && item.id === "helper"));
    assert.match(readFileSync(join(cwd, ".claude", "agents", "helper.md"), "utf8"), /Help/);

    await app.json(`/api/projects/${project.name}/agent-context`, {
      method: "PATCH",
      body: JSON.stringify({ kind: "skill", id: "notes", enabled: false }),
    });

    const started = await app.json<{ id: string }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ project: project.name, harness: "grok", prompt: { text: "Go" } }),
    });
    assert.ok(started.id);
    const opts = grok.starts.at(-1)!;
    assert.match(opts.instructions!, /Global guidance/);
    assert.match(opts.instructions!, /Project rules/);
    assert.match(opts.instructions!, /Project ship/);
    assert.doesNotMatch(opts.instructions!, /Library ship/);
    assert.doesNotMatch(opts.instructions!, /Take notes/);
    assert.equal(opts.agents?.helper?.description, "Helps.");
    assert.equal(opts.mcpServers?.local && opts.mcpServers.local.type === "stdio" ? opts.mcpServers.local.command : "", "local-mcp");
    assert.equal(opts.mcpServers?.docs && opts.mcpServers.docs.type === "stdio" ? opts.mcpServers.docs.command : "", "docs-mcp");

    await app.json(`/api/projects/${project.name}/agent-context/skill/ship`, { method: "DELETE" });
    assert.equal(await app.json<ProjectAgentContext>(`/api/projects/${project.name}/agent-context`).then((view) =>
      view.project.some((item) => item.id === "ship")), false);
  } finally {
    await app.close();
  }
});

test("an OAuth library server is injected with its token over a stale same-id project file entry, for grok and claude", async () => {
  const app = await startApp({ harnesses: { claude: fakeHarness(), grok: fakeHarness() } });
  const cwd = tempDir("odin-context-oauth-");
  const stale = { type: "http", url: "https://mcp.example.test/mcp", oauth: {} };
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { canva: stale, local: { command: "local-mcp" } } }));
  mkdirSync(join(cwd, ".grok"), { recursive: true });
  writeFileSync(join(cwd, ".grok", "mcp.json"), JSON.stringify({ mcpServers: { canva: stale } }));
  try {
    const project = await app.json<ProjectDetail>("/api/projects", { method: "POST", body: JSON.stringify({ path: cwd }) });
    await app.json(`/api/library/mcp/canva`, { method: "PUT", body: JSON.stringify({ files: { "canva.json": JSON.stringify({ name: "Canva", ...stale }) } }) });
    const services = app.app.services;
    services.mcpOAuth.accessToken = async (id: string) => `tok-${id}`;
    for (const harness of ["grok", "claude"]) {
      const resolved = await services.agentContext.resolve(project.name, cwd, harness);
      const server = resolved.mcpServers.canva;
      assert.ok(server && server.type !== "stdio", harness);
      assert.equal(server.headers?.Authorization, "Bearer tok-canva", harness);
      assert.equal(server.url, "https://mcp.example.test/mcp");
    }
    const claude = await services.agentContext.resolve(project.name, cwd, "claude");
    assert.equal(claude.mcpServers.local, undefined);
  } finally {
    await app.close();
  }
});
