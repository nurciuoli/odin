// Changelog fragments. PRs add `changes/<name>.md` instead of editing CHANGELOG.md.
//   yarn changelog:check            validate the fragments
//   yarn changelog:release X.Y.Z    move them under a new `## [X.Y.Z]` heading in CHANGELOG.md and delete them
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const UNRELEASED = "## [Unreleased]";

export function listFragments(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort();
}

/** Problems with one fragment's text; empty when it is valid. */
export function checkFragment(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return ["is empty"];
  if (!lines[0].startsWith("- ")) return ['must start with a list item ("- ...")'];
  if (lines.some((l) => l.startsWith("#"))) return ["must not contain headings"];
  return [];
}

/** Put fragment entries under a new version heading, after whatever Unreleased already holds. */
export function assemble(changelog: string, version: string, fragments: string[]): string {
  const nl = changelog.includes("\r\n") ? "\r\n" : "\n";
  const text = changelog.replace(/\r\n/g, "\n");
  const start = text.indexOf(UNRELEASED);
  if (start < 0) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" heading`);
  const bodyStart = start + UNRELEASED.length;
  const next = text.indexOf("\n## [", bodyStart);
  const end = next < 0 ? text.length : next + 1;
  const existing = text.slice(bodyStart, end).split("\n").filter((l) => l.trim() !== "");
  const entries = [...existing, ...fragments.flatMap((f) => f.split(/\r?\n/).filter((l) => l.trim() !== ""))];
  if (entries.length === 0) throw new Error("nothing to release: no fragments and Unreleased is empty");
  const out = `${text.slice(0, start)}${UNRELEASED}\n\n## [${version}]\n\n${entries.join("\n")}\n\n${text.slice(end)}`;
  return out.replace(/\n/g, nl);
}

function main(argv: string[]): number {
  const dir = join(root, "changes");
  const names = listFragments(dir);
  if (argv[0] === "check") {
    let bad = 0;
    for (const n of names) {
      for (const p of checkFragment(readFileSync(join(dir, n), "utf8"))) {
        console.error(`changes/${n}: ${p}`);
        bad++;
      }
    }
    return bad ? 1 : 0;
  }
  if (argv[0] === "release") {
    const version = argv[1];
    if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
      console.error("usage: yarn changelog:release X.Y.Z");
      return 2;
    }
    const fragments = names.map((n) => readFileSync(join(dir, n), "utf8"));
    const problems = names.flatMap((n, i) => checkFragment(fragments[i]).map((p) => `changes/${n}: ${p}`));
    if (problems.length) {
      console.error(problems.join("\n"));
      return 1;
    }
    const file = join(root, "CHANGELOG.md");
    writeFileSync(file, assemble(readFileSync(file, "utf8"), version, fragments));
    for (const n of names) rmSync(join(dir, n));
    console.log(`CHANGELOG.md: released ${version} (${names.length} fragment${names.length === 1 ? "" : "s"})`);
    return 0;
  }
  console.error("usage: changelog.ts check | release X.Y.Z");
  return 2;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) process.exit(main(process.argv.slice(2)));
