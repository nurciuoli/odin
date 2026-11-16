// SettingsService: AppSettings in `app_settings` (one JSON row per key) and pricing.json. docs/contracts.md#settings.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { TOOL_NAMES, type AppSettings, type ModelPrice, type PermissionMode, type ToolName } from "@odin/shared/api";
import { normaliseModel } from "@odin/shared/pricing";
import { HttpError } from "../http/util.ts";
import type { Deps, Services, SettingsService } from "../services.ts";
import { createPricingLoader, validPrice } from "./pricing.ts";

const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultModel: null,
  defaultPermissionMode: "default",
  defaultWorktree: false,
  notifyOnWaiting: true,
  notifyOnFinished: true,
  launcherShortcut: "CommandOrControl+Shift+Space",
  editorCommand: "code",
  toolPaths: {},
};

const CONTROL = /[\u0000-\u001f\u007f]/;

function checkSetting<K extends keyof AppSettings>(key: K, value: unknown): AppSettings[K] {
  const bad = (what: string): never => {
    throw new HttpError(400, `${key} must be ${what}`);
  };
  switch (key) {
    case "defaultHarness":
      if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) bad("a harness id");
      return value as AppSettings[K];
    case "harnessDefaults": {
      if (!value || typeof value !== "object" || Array.isArray(value)) bad("a map of harness defaults");
      const out = Object.create(null);
      for (const [harness, entry] of Object.entries(value as Record<string, unknown>)) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(harness) || !entry || typeof entry !== "object" || Array.isArray(entry)) bad("a map of harness defaults");
        const fields = entry as Record<string, unknown>;
        if (Object.keys(fields).some(k => k !== "model" && k !== "permissionMode")) bad("model and permissionMode only");
        out[harness] = { model: checkSetting("defaultModel", fields.model), permissionMode: checkSetting("defaultPermissionMode", fields.permissionMode) };
      }
      return out;
    }
    case "defaultModel":
      if (value !== null && (typeof value !== "string" || value.length > 200)) bad("a string or null");
      return (typeof value === "string" && value.trim() ? value.trim() : null) as AppSettings[K];
    case "defaultPermissionMode":
      if (!PERMISSION_MODES.includes(value as PermissionMode)) bad(`one of ${PERMISSION_MODES.join(", ")}`);
      return value as AppSettings[K];
    case "defaultWorktree":
    case "notifyOnWaiting":
    case "notifyOnFinished":
      if (typeof value !== "boolean") bad("true or false");
      return value as AppSettings[K];
    case "launcherShortcut":
      if (value === null) return null as AppSettings[K];
      if (typeof value !== "string" || value.length > 100 || CONTROL.test(value)) bad("an accelerator string or null");
      return ((value as string).trim() || null) as AppSettings[K];
    case "editorCommand":
      if (typeof value !== "string" || !value.trim() || value.length > 200 || CONTROL.test(value)) bad("a non-empty command");
      return (value as string).trim() as AppSettings[K];
    case "toolPaths": {
      if (!value || typeof value !== "object" || Array.isArray(value)) bad("a map of tool paths");
      const out: Partial<Record<ToolName, string>> = {};
      for (const [tool, path] of Object.entries(value as Record<string, unknown>)) {
        if (!(TOOL_NAMES as readonly string[]).includes(tool)) bad(`keyed by ${TOOL_NAMES.join(", ")}`);
        if (typeof path !== "string" || path.length > 1024 || CONTROL.test(path)) bad("absolute paths");
        const p = (path as string).trim();
        if (!p) continue;
        if (!isAbsolute(p)) bad("absolute paths");
        out[tool as ToolName] = p;
      }
      return out as AppSettings[K];
    }
    default:
      throw new HttpError(400, `unknown setting ${JSON.stringify(String(key).slice(0, 40))}`);
  }
}

export function createSettingsService(deps: Deps, _services: Services): SettingsService {
  const { db } = deps;
  const pricing = createPricingLoader(deps.config.pricingPath);
  const read = db.prepare("SELECT key, value FROM app_settings");
  const write = db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

  function get(): AppSettings {
    const out: AppSettings = { ...DEFAULT_APP_SETTINGS };
    for (const row of read.all() as { key: string; value: string }[]) {
      if (!Object.hasOwn(DEFAULT_APP_SETTINGS, row.key) && row.key !== "defaultHarness" && row.key !== "harnessDefaults") continue;
      try {
        (out as unknown as Record<string, unknown>)[row.key] = checkSetting(row.key as keyof AppSettings, JSON.parse(row.value));
      } catch {
        // A damaged row falls back to the default.
      }
    }
    return out;
  }

  function update(patch: Partial<AppSettings>): AppSettings {
    const checked: [string, unknown][] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      checked.push([key, checkSetting(key as keyof AppSettings, value)]);
    }
    db.exec("BEGIN");
    try {
      for (const [key, value] of checked) write.run(key, JSON.stringify(value));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return get();
  }

  function savePricing(prices: Record<string, ModelPrice>): void {
    const clean: Record<string, ModelPrice> = {};
    for (const [model, price] of Object.entries(prices)) {
      if (!validPrice(price)) throw new HttpError(400, `price for ${JSON.stringify(model.slice(0, 80))} needs non-negative input, output, cacheRead and cacheWrite`);
      const { input, output, cacheRead, cacheWrite } = price;
      clean[normaliseModel(model)] = { input, output, cacheRead, cacheWrite };
    }
    const path = deps.config.pricingPath;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`);
    renameSync(tmp, path);
    pricing.reset();
  }

  return { get, update, pricing, savePricing };
}
