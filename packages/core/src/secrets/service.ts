// SecretsService: named values for library MCP specs. docs/contracts.md#secrets.
import { join } from "node:path";
import type { SecretInfo, SecretsResponse } from "@odin/shared/api";
import { fillSecrets, SECRET_MAX_BYTES, SECRET_NAME_PATTERN, secretRefs } from "@odin/shared/library";
import { HttpError } from "../http/util.ts";
import type { Deps, SecretsService, Services } from "../services.ts";
import { createFileSecretStore, type SecretStore } from "./store.ts";

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Secret names each library MCP spec refers to (args, env values, url, header values). Broken specs refer to none. */
function mcpRefs(services: Services): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const asset of services.library.list("mcp")) {
    if (asset.error) continue;
    const spec = asset.meta as { url?: unknown; args?: unknown; env?: unknown; headers?: unknown };
    const strings: string[] = [];
    if (typeof spec.url === "string") strings.push(spec.url);
    if (Array.isArray(spec.args)) strings.push(...spec.args.filter((a): a is string => typeof a === "string"));
    for (const map of [spec.env, spec.headers]) {
      if (map && typeof map === "object") strings.push(...Object.values(map).filter((v): v is string => typeof v === "string"));
    }
    for (const name of new Set(strings.flatMap(secretRefs))) byName.set(name, [...(byName.get(name) ?? []), asset.id]);
  }
  return byName;
}

export function createSecretsService(deps: Deps, services: Services, store: SecretStore = createFileSecretStore(join(deps.config.home, "secrets.json"))): SecretsService {
  const load = () => {
    try {
      return store.read();
    } catch (err) {
      throw new HttpError(500, `secret store unreadable: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  };
  const nameError = (name: string) => {
    if (!SECRET_NAME_PATTERN.test(name)) throw new HttpError(400, "secret names start with a letter and use letters, digits, _ and - (64 at most)");
  };
  return {
    list(): SecretsResponse {
      const secrets = load();
      const refs = mcpRefs(services);
      const info = (name: string): SecretInfo => ({ name, createdAt: secrets[name]!.createdAt, updatedAt: secrets[name]!.updatedAt, usedBy: refs.get(name) ?? [] });
      return {
        secrets: Object.keys(secrets).sort().map(info),
        missing: [...refs].filter(([name]) => !(name in secrets)).map(([name, usedBy]) => ({ name, usedBy })).sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    put(name, value): SecretInfo {
      nameError(name);
      if (typeof value !== "string" || value === "") throw new HttpError(400, "value must be a non-empty string");
      if (Buffer.byteLength(value) > SECRET_MAX_BYTES) throw new HttpError(400, `value is over ${SECRET_MAX_BYTES} bytes`);
      // Headers and env values cannot carry these; refusing them here keeps a bad paste from failing at launch.
      if (CONTROL.test(value)) throw new HttpError(400, "value must not contain control characters or line breaks");
      const secrets = load();
      const now = deps.now().toISOString();
      secrets[name] = { value, createdAt: secrets[name]?.createdAt ?? now, updatedAt: now };
      try {
        store.write(secrets);
      } catch (err) {
        throw new HttpError(500, `secret store not writable: ${err instanceof Error ? err.message : "unknown error"}`);
      }
      return { name, createdAt: secrets[name]!.createdAt, updatedAt: now, usedBy: mcpRefs(services).get(name) ?? [] };
    },
    remove(name) {
      nameError(name);
      const secrets = load();
      if (!(name in secrets)) throw new HttpError(404, `no secret named ${name}`);
      delete secrets[name];
      store.write(secrets);
    },
    fill(text, what) {
      const secrets = load();
      return fillSecrets(text, (name) => {
        const entry = secrets[name];
        if (!entry) throw new HttpError(400, `${what} needs secret ${name}, which is not set`);
        return entry.value;
      });
    },
  };
}
