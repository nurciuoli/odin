import { readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ASSET_ID_PATTERN } from "@odin/shared/library";
import { parseFrontmatter } from "../frontmatter.ts";
import { readRegularFile, resolveInside, writeFileAtomic } from "./files.ts";

/** One-time, additive migration. Original files and all historical versions remain untouched. */
export function migrateLegacyLibrary(root: string, db: DatabaseSync): void {
  const key = "library.skills-migration.v1";
  if (db.prepare("SELECT 1 FROM app_settings WHERE key = ?").get(key)) return;
  for (const kind of ["prompt", "command", "template"] as const) {
    const dir = join(root, `${kind}s`);
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const name of names) {
      const ext = kind === "template" ? ".json" : ".md";
      if (!name.endsWith(ext)) continue;
      const id = name.slice(0, -ext.length);
      if (!ASSET_ID_PATTERN.test(id)) continue;
      const source = readRegularFile(resolveInside(root, `${kind}s/${name}`));
      if (!source) continue;
      let body = source;
      let description = `Reusable instructions from ${id}`;
      const extra: Record<string, string> = {};
      if (kind === "template") {
        let spec: Record<string, unknown>;
        try { spec = JSON.parse(source); } catch { continue; }
        if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue;
        body = typeof spec.prompt === "string" ? spec.prompt : "";
        if (!body.trim() && typeof spec.promptId === "string" && ASSET_ID_PATTERN.test(spec.promptId))
          body = readRegularFile(resolveInside(root, `prompts/${spec.promptId}.md`)) ?? "";
        if (typeof spec.description === "string" && spec.description.trim()) description = spec.description;
        // Keep former runtime choices as a reference, never as automatic launch behavior.
        extra["references/former-template.json"] = source;
      }
      const parsed = /^---\r?\n/.test(body) ? parseFrontmatter(body) : null;
      if (parsed?.data?.description && typeof parsed.data.description === "string") description = parsed.data.description;
      body = parsed ? parsed.body : body;
      if (!body.trim()) body = "Review references/former-template.json for the previous configuration before choosing settings.";
      body = body.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, "<$1>");
      let targetId = id;
      let target = resolveInside(root, `skills/${targetId}/SKILL.md`);
      if (readRegularFile(target) !== null) {
        targetId = `${kind}-${id}`.slice(0, 64).replace(/-$/, "");
        target = resolveInside(root, `skills/${targetId}/SKILL.md`);
        if (readRegularFile(target) !== null) continue;
      }
      writeFileAtomic(target, `---\nname: ${targetId}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`);
      for (const [file, content] of Object.entries(extra))
        writeFileAtomic(resolveInside(root, `skills/${targetId}/${file}`), content);
    }
  }
  db.prepare("INSERT INTO app_settings (key, value) VALUES (?, 'true')").run(key);
}
