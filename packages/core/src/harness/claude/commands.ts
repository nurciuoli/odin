// The SDK's slash-command list → Odin's. Odin owns some commands (the web runs /clear, /model, /rename and
// /send itself) and some make no sense outside a terminal; those are left out. docs/contracts.md#sessions (Slash commands).
import type { SlashCommand } from "@odin/shared/harness";

/** Commands Odin handles itself or that only matter in a terminal. */
const HIDDEN = new Set(["clear", "reset", "new", "model", "rename", "send", "now", "color", "focus", "heapdump"]);

const hidden = (name: string) => HIDDEN.has(name) || name.startsWith("__");

/** The SDK's `SlashCommand` rows (initialize response, `supportedCommands()`, `commands_changed`). */
export function slashCommandsFromSdk(list: unknown): SlashCommand[] {
  if (!Array.isArray(list)) return [];
  const byName = new Map<string, SlashCommand>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name.replace(/^\//, "") : "";
    if (!name || hidden(name)) continue;
    const builtin = c.builtin === true;
    // Rows can share a name; /name runs the built-in one when there is one.
    if (byName.get(name)?.source === "builtin" && !builtin) continue;
    const aliases = Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === "string" && !hidden(a)) : [];
    byName.set(name, {
      name,
      description: typeof c.description === "string" ? c.description : "",
      argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : "",
      ...(aliases.length ? { aliases } : {}),
      source: builtin ? "builtin" : "custom",
    });
  }
  return [...byName.values()];
}

/** Bare names (`system/init.slash_commands`), used until the full list is known. */
export function slashCommandsFromNames(names: unknown): SlashCommand[] {
  if (!Array.isArray(names)) return [];
  return slashCommandsFromSdk(names.filter((n): n is string => typeof n === "string").map((name) => ({ name })));
}
