// Merge installs: library MCP servers into a project's .mcp.json (`mcpServers.<id>`), settings profiles into
// .claude/settings.json (permission rules appended without duplicates, hook entries added). Pure functions on parsed
// JSON: callers read and write the files. Everything else in the documents is left exactly as it was.
import type { SettingsProfileSpec } from "@odin/shared/api";
import { PERMISSION_LISTS } from "./parse.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Structural equality for JSON values (object key order ignored). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Parses a JSON file's text as an object; `null` text (no file) gives null. Throws a readable Error otherwise. */
export function parseJsonObject(text: string | null, label: string): Obj | null {
  if (text === null) return null;
  if (!text.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON (${(err as Error).message}); fix it by hand first`);
  }
  if (!isObj(v)) throw new Error(`${label} must hold a JSON object; fix it by hand first`);
  return v;
}

export function formatJson(doc: unknown): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

// ── MCP ────────────────────────────────────────────────────────────────────

/** The server entry under mcpServers.<id>, or null. Throws when mcpServers isn't an object. */
export function mcpEntry(doc: Obj | null, id: string): unknown {
  if (!doc || doc.mcpServers === undefined) return null;
  if (!isObj(doc.mcpServers)) throw new Error(".mcp.json: mcpServers must be an object; fix it by hand first");
  return Object.hasOwn(doc.mcpServers, id) ? doc.mcpServers[id] : null;
}

export function setMcpEntry(doc: Obj | null, id: string, spec: unknown): Obj {
  const out = clone(doc ?? {});
  mcpEntry(out, id); // validates the shape
  const servers = isObj(out.mcpServers) ? out.mcpServers : {};
  servers[id] = clone(spec);
  out.mcpServers = servers;
  return out;
}

export function removeMcpEntry(doc: Obj, id: string): Obj {
  const out = clone(doc);
  if (isObj(out.mcpServers)) delete out.mcpServers[id];
  return out;
}

// ── settings ───────────────────────────────────────────────────────────────

/** The part of a settings profile Odin wrote, or that is present: rule lists and hook entries per event. */
export interface SettingsFragment {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  hooks?: Record<string, unknown[]>;
}

function hookEntries(spec: SettingsProfileSpec | SettingsFragment): [string, unknown[]][] {
  return Object.entries(spec.hooks ?? {}).filter((e): e is [string, unknown[]] => Array.isArray(e[1]));
}

function checkSettingsShape(doc: Obj): void {
  if (doc.permissions !== undefined && !isObj(doc.permissions)) throw new Error(".claude/settings.json: permissions must be an object; fix it by hand first");
  if (isObj(doc.permissions)) {
    for (const list of PERMISSION_LISTS) {
      const v = doc.permissions[list];
      if (v !== undefined && !Array.isArray(v)) throw new Error(`.claude/settings.json: permissions.${list} must be a list; fix it by hand first`);
    }
  }
  if (doc.hooks !== undefined && !isObj(doc.hooks)) throw new Error(".claude/settings.json: hooks must be an object; fix it by hand first");
  if (isObj(doc.hooks)) {
    for (const [event, v] of Object.entries(doc.hooks)) {
      if (!Array.isArray(v)) throw new Error(`.claude/settings.json: hooks.${event} must be a list; fix it by hand first`);
    }
  }
}

/** Adds the profile: rules not already there are appended, hook entries not already there are added. */
export function addSettings(doc: Obj | null, spec: SettingsProfileSpec): { doc: Obj; added: SettingsFragment } {
  const out = clone(doc ?? {});
  checkSettingsShape(out);
  const added: SettingsFragment = {};
  for (const list of PERMISSION_LISTS) {
    const rules = spec.permissions?.[list] ?? [];
    for (const rule of rules) {
      const perms = (out.permissions ??= {}) as Obj;
      const current = (perms[list] ??= []) as unknown[];
      if (current.includes(rule)) continue;
      current.push(rule);
      ((added.permissions ??= {})[list] ??= []).push(rule);
    }
  }
  for (const [event, entries] of hookEntries(spec)) {
    for (const entry of entries) {
      const hooks = (out.hooks ??= {}) as Obj;
      const current = (hooks[event] ??= []) as unknown[];
      if (current.some((e) => deepEqual(e, entry))) continue;
      current.push(clone(entry));
      ((added.hooks ??= {})[event] ??= []).push(clone(entry));
    }
  }
  return { doc: out, added };
}

/** Removes exactly the given entries (one occurrence each); everything else stays. Empty lists Odin emptied go too. */
export function removeSettings(doc: Obj, fragment: SettingsFragment): { doc: Obj; changed: boolean } {
  const out = clone(doc);
  checkSettingsShape(out);
  let changed = false;
  const perms = isObj(out.permissions) ? out.permissions : null;
  for (const list of PERMISSION_LISTS) {
    const current = perms?.[list];
    if (!perms || !Array.isArray(current)) continue;
    for (const rule of fragment.permissions?.[list] ?? []) {
      const i = current.indexOf(rule);
      if (i >= 0) {
        current.splice(i, 1);
        changed = true;
        if (!current.length) delete perms[list];
      }
    }
  }
  if (perms && changed && !Object.keys(perms).length) delete out.permissions;
  const hooks = isObj(out.hooks) ? out.hooks : null;
  let hooksChanged = false;
  for (const [event, entries] of hookEntries(fragment)) {
    const current = hooks?.[event];
    if (!hooks || !Array.isArray(current)) continue;
    for (const entry of entries) {
      const i = current.findIndex((e) => deepEqual(e, entry));
      if (i >= 0) {
        current.splice(i, 1);
        hooksChanged = true;
        if (!current.length) delete hooks[event];
      }
    }
  }
  if (hooks && hooksChanged && !Object.keys(hooks).length) delete out.hooks;
  return { doc: out, changed: changed || hooksChanged };
}

/** The entries of `spec` that are present in the document now. */
export function presentSettings(doc: Obj | null, spec: SettingsProfileSpec | SettingsFragment): SettingsFragment {
  const out: SettingsFragment = {};
  if (!doc) return out;
  const perms = isObj(doc.permissions) ? doc.permissions : {};
  for (const list of PERMISSION_LISTS) {
    const current = Array.isArray(perms[list]) ? (perms[list] as unknown[]) : [];
    for (const rule of spec.permissions?.[list] ?? []) {
      if (current.includes(rule)) ((out.permissions ??= {})[list] ??= []).push(rule);
    }
  }
  const hooks = isObj(doc.hooks) ? doc.hooks : {};
  for (const [event, entries] of hookEntries(spec)) {
    const current = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    for (const entry of entries) {
      if (current.some((e) => deepEqual(e, entry))) ((out.hooks ??= {})[event] ??= []).push(clone(entry));
    }
  }
  return out;
}

/** How many rules and hook entries a fragment holds. */
export function fragmentSize(f: SettingsProfileSpec | SettingsFragment): number {
  let n = 0;
  for (const list of PERMISSION_LISTS) n += f.permissions?.[list]?.length ?? 0;
  for (const [, entries] of hookEntries(f)) n += entries.length;
  return n;
}
