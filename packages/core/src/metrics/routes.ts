// GET /api/metrics?groupBy=model,template&project=&since=&until= (docs/contracts.md#metrics).
import type { MetricsDimension } from "@odin/shared/api";
import { HttpError } from "../http/util.ts";
import type { RegisterRoutes } from "../services.ts";
import { ACTIVITY_MAX_DAYS } from "./service.ts";

export const registerMetricsRoutes: RegisterRoutes = (router, _deps, services) => {
  router.get("/api/metrics", ({ url }) => {
    const groupBy = (url.searchParams.get("groupBy") ?? "").split(",").map((s) => s.trim()).filter(Boolean) as MetricsDimension[];
    const project = url.searchParams.get("project") || undefined;
    const since = url.searchParams.get("since") || undefined;
    const until = url.searchParams.get("until") || undefined;
    return services.metrics.query({ groupBy, ...(project ? { project } : {}), ...(since ? { since } : {}), ...(until ? { until } : {}) });
  });

  // GET /api/projects/:name/activity?days=84 (docs/contracts.md#metrics).
  router.get("/api/projects/:name/activity", ({ url, params }) => {
    const raw = url.searchParams.get("days");
    const days = raw === null || raw === "" ? 84 : /^[0-9]{1,4}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(days) || days < 1 || days > ACTIVITY_MAX_DAYS) throw new HttpError(400, `days must be an integer from 1 to ${ACTIVITY_MAX_DAYS}`);
    if (!services.projects.get(params.name)) throw new HttpError(404, `unknown project ${params.name}`);
    return services.metrics.activity(params.name, days);
  });
};
