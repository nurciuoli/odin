// YAML frontmatter for markdown files (PROJECT.md, agent files, SKILL.md): a small, never-throwing subset parser.
// Supports scalars (plain, "double", 'single'), comments, one level of nested map, lists (`[a, b]` and `- item`)
// and block strings (`|`, `>`). Anything else is reported in `errors` and skipped.

export type FrontmatterValue = string | null | string[] | { [key: string]: string | null };

export interface Frontmatter {
  /** null when the file has no frontmatter block at all. */
  data: Record<string, FrontmatterValue> | null;
  errors: string[];
  /** The markdown after the closing ---, or the whole text when there is no frontmatter. */
  body: string;
}

/** Unquotes a scalar. Returns undefined (and pushes an error) when it can't be read. */
function scalar(raw: string, where: string, errors: string[], inFlow = false): string | null | undefined {
  const v = raw.trim();
  if (v.startsWith('"')) {
    let out = "";
    for (let i = 1; i < v.length; i++) {
      const c = v[i];
      if (c === "\\" && i + 1 < v.length) {
        const n = v[++i];
        out += n === "n" ? "\n" : n === "t" ? "\t" : n;
      } else if (c === '"') {
        const rest = v.slice(i + 1).trim();
        if (rest && !rest.startsWith("#")) { errors.push(`${where}: text after the closing quote`); return undefined; }
        return out;
      } else out += c;
    }
    errors.push(`${where}: unterminated string`);
    return undefined;
  }
  if (v.startsWith("'")) {
    let out = "";
    for (let i = 1; i < v.length; i++) {
      if (v[i] === "'") {
        if (v[i + 1] === "'") { out += "'"; i++; continue; }
        const rest = v.slice(i + 1).trim();
        if (rest && !rest.startsWith("#")) { errors.push(`${where}: text after the closing quote`); return undefined; }
        return out;
      }
      out += v[i];
    }
    errors.push(`${where}: unterminated string`);
    return undefined;
  }
  // Plain scalar: a comment starts at " #".
  const hash = inFlow ? -1 : v.search(/(^|\s)#/);
  const plain = (hash >= 0 ? v.slice(0, hash) : v).trim();
  if (plain === "" || plain === "~" || plain === "null") return null;
  if (/^([[{|>&*!]|-(\s|$))/.test(plain)) {
    errors.push(`${where}: nested lists, flow maps and anchors aren't supported`);
    return undefined;
  }
  return plain;
}

/** Splits the inside of `[a, "b, c", 'd']` on top-level commas. */
function splitFlow(inner: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < inner.length) cur += inner[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === ",") { items.push(cur); cur = ""; continue; }
    cur += c;
  }
  items.push(cur);
  return items.map((s) => s.trim()).filter((s, i, all) => s !== "" || i < all.length - 1);
}

/** `[a, b]` (with an optional trailing comment). Undefined (and an error) when malformed. */
function flowList(raw: string, where: string, errors: string[]): string[] | undefined {
  let v = raw.trim();
  // Find the closing bracket outside quotes, then allow only a comment after it.
  let quote: string | null = null;
  let close = -1;
  for (let i = 1; i < v.length; i++) {
    const c = v[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "]") { close = i; break; }
    else if (c === "[" || c === "{") { errors.push(`${where}: nested lists and maps aren't supported`); return undefined; }
  }
  if (close < 0) { errors.push(`${where}: unclosed [`); return undefined; }
  const rest = v.slice(close + 1).trim();
  if (rest && !rest.startsWith("#")) { errors.push(`${where}: text after the closing ]`); return undefined; }
  v = v.slice(1, close);
  const out: string[] = [];
  for (const item of splitFlow(v)) {
    const s = scalar(item, where, errors, true);
    if (s === undefined) return undefined;
    if (s !== null) out.push(s);
  }
  return out;
}

const isBlank = (l: string) => !l.trim() || l.trim().startsWith("#");

/** Parses the `---` block at the top of a markdown file. `file` names it in the "no frontmatter" error. */
export function parseFrontmatter(text: string, file = "PROJECT.md"): Frontmatter {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { data: null, errors: [`${file} has no frontmatter (it must start with ---)`], body: clean };
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
  if (end < 0) return { data: null, errors: ["the frontmatter has no closing ---"], body: "" };
  const body = lines.slice(end + 1).join("\n");

  const data: Record<string, FrontmatterValue> = {};
  const errors: string[] = [];
  let parent: string | null = null; // the key whose nested map or list we're filling
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    const where = `line ${i + 1}`;
    if (/^\t/.test(line)) { errors.push(`${where}: tabs can't indent YAML`); continue; }
    const indented = /^\s/.test(line);
    const item = /^\s*-(?:\s+(.*)|\s*)$/.exec(line);
    if (item && parent && Array.isArray(data[parent])) {
      const v = scalar(item[1] ?? "", where, errors);
      if (v !== undefined && v !== null) (data[parent] as string[]).push(v);
      continue;
    }
    const m = /^\s*([A-Za-z0-9_-]+)\s*:(?:\s(.*)|$)/.exec(line);
    if (!m) { errors.push(`${where}: expected "key: value"`); continue; }
    const key = m[1];
    const rest = m[2] ?? "";
    if (indented) {
      const map = parent ? data[parent] : undefined;
      if (!parent || !map || typeof map !== "object" || Array.isArray(map)) { errors.push(`${where}: unexpected indentation`); continue; }
      const v = scalar(rest, where, errors);
      if (v !== undefined) map[key] = v;
      continue;
    }
    parent = null;
    if (Object.hasOwn(data, key)) errors.push(`${where}: duplicate key ${key}`);
    const bare = rest.trim();
    if (bare === "" || bare.startsWith("#")) {
      // A nested map, a block list, or an empty value (null).
      const next = lines.slice(i + 1, end).find((l) => !isBlank(l));
      if (next !== undefined && /^\s*-(\s|$)/.test(next)) {
        data[key] = [];
        parent = key;
      } else if (next !== undefined && /^ +\S/.test(next)) {
        data[key] = {};
        parent = key;
      } else data[key] = null;
      continue;
    }
    if (bare.startsWith("[")) {
      const list = flowList(bare, where, errors);
      if (list !== undefined) data[key] = list;
      continue;
    }
    const block = /^([|>])([+-]?)\s*(#.*)?$/.exec(bare);
    if (block) {
      // Block string: the following more-indented (or blank) lines.
      const collected: string[] = [];
      let j = i + 1;
      for (; j < end; j++) {
        const l = lines[j];
        if (l.trim() && !/^\s/.test(l)) break;
        collected.push(l);
      }
      i = j - 1;
      while (collected.length && !collected.at(-1)!.trim()) collected.pop();
      const indent = Math.min(...collected.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
      const stripped = collected.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      data[key] = block[1] === "|"
        ? stripped.join("\n")
        : stripped.join("\n").split(/\n{2,}/).map((p) => p.replace(/\n/g, " ")).join("\n");
      continue;
    }
    const v = scalar(rest, where, errors);
    if (v !== undefined) data[key] = v;
  }
  return { data, errors, body };
}
