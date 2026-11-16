// GET|PATCH /api/settings (docs/contracts.md#settings).
import type { HarnessInfo, ModelPrice, ReadinessResponse, SettingsResponse, UpdateSettingsRequest } from "@odin/shared/api";
import { HttpError, readJson } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";
import { validPrice } from "./pricing.ts";
import { claudeLoginPresent, readiness, toolVersion } from "./readiness.ts";
import { resolveTool } from "../tools/resolve.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const registerSettingsRoutes: RegisterRoutes = (router, deps, services) => {
  async function harnessInfo(): Promise<HarnessInfo[]> {
    const harnesses: HarnessInfo[] = [];
    for (const harness of Object.values(deps.harnesses)) {
      let check: { available: boolean; note: string | null };
      try {
        check = await harness.check();
      } catch (err) {
        check = { available: false, note: err instanceof Error ? err.message : "check failed" };
      }
      harnesses.push({ id: harness.id, name: harness.name, available: check.available, note: check.note, ...(harness.capabilities ? { capabilities: harness.capabilities } : {}) });
    }
    return harnesses;
  }

  const github = () => ({ configured: Boolean(deps.config.githubToken), source: deps.config.githubToken ? deps.config.githubTokenSource : null });

  async function respond(): Promise<SettingsResponse> {
    const harnesses = await harnessInfo();
    return {
      settings: services.settings.get(),
      pricing: services.settings.pricing(),
      github: github(),
      harnesses,
      libraryPath: services.library.root,
    };
  }

  router.get("/api/settings", () => respond());

  router.get("/api/readiness", async (): Promise<ReadinessResponse> => {
    const [harnesses, gitVersion, ghVersion] = await Promise.all([harnessInfo(), toolVersion(resolveTool("git")), toolVersion(resolveTool("gh"))]);
    return readiness({
      harnesses,
      gitVersion,
      github: github(),
      ghFound: ghVersion !== null,
      claudeLogin: claudeLoginPresent(),
      projectCount: services.projects.list().length,
    });
  });

  router.patch("/api/settings", async ({ req }) => {
    const body = (await readJson(req)) as UpdateSettingsRequest;
    if (!isObject(body)) throw new HttpError(400, "body must be an object");
    if (body.settings !== undefined && !isObject(body.settings)) throw new HttpError(400, "settings must be an object");
    if (body.pricing !== undefined && !isObject(body.pricing)) throw new HttpError(400, "pricing must be an object");
    // Reject a bad price before settings are written, so a failed request changes nothing.
    for (const [model, price] of Object.entries(body.pricing ?? {})) {
      if (!validPrice(price)) throw new HttpError(400, `price for ${JSON.stringify(model.slice(0, 80))} needs non-negative input, output, cacheRead and cacheWrite`);
    }
    if (body.settings) services.settings.update(body.settings);
    if (body.pricing) services.settings.savePricing(body.pricing as Record<string, ModelPrice>);
    return respond();
  });
};
