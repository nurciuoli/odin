// Shared test scaffolding: an app on a random port with temp dirs and no network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@odin/shared/events";
import { type Config, loadConfig } from "./config.ts";
import { openDb } from "./db/db.ts";
import { EventBus } from "./events.ts";
import { type App, createApp } from "./server.ts";
import type { Deps, Services } from "./services.ts";
import { notImplemented } from "./stub.ts";
import { fakeHarness } from "./harness/fake.ts";
import type { Harnesses } from "./harness/types.ts";
import { SERVICE_NAMES } from "./services.ts";

export const INGEST_TOKEN = "test-ingest-token";
export const FIXED_NOW = new Date("2026-10-17T12:00:00Z");

export function tempConfig(overrides: Partial<Config> = {}): Config {
  const root = mkdtempSync(join(tmpdir(), "odin-test-"));
  return loadConfig({}, {
    home: join(root, "home"),
    webDist: join(root, "web-dist"),
    port: 0,
    ingestToken: INGEST_TOKEN,
    githubToken: "",
    githubApiUrl: "https://gh.invalid",
    githubSyncMs: 0,
    projectsRescanMs: 0,
    ...overrides,
  });
}

/** fetch that fails: tests never reach the network unless they inject a fake. */
export const noNetwork: typeof fetch = async () => {
  throw new Error("no network in tests");
};

/** Deps for unit-testing one service: in-memory DB, a bus that records events, a fixed clock. */
export function testDeps(overrides: Partial<Deps> = {}): Deps & { events: ServerEvent[] } {
  const config = tempConfig();
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return { config, db: openDb(":memory:"), bus, githubFetch: noNetwork, mcpFetch: noNetwork, now: () => FIXED_NOW, harnesses: { claude: fakeHarness({ now: () => FIXED_NOW }) }, events, ...overrides };
}

export interface TestApp {
  app: App;
  base: string;
  config: Config;
  api(path: string, init?: RequestInit): Promise<Response>;
  json<T = any>(path: string, init?: RequestInit): Promise<T>;
  close(): Promise<void>;
}

/**
 * A real app on a random port with temp dirs, no network, and the fake harness (pass your own to script it).
 * Tests never touch ~/.odin, ~/.claude or GitHub.
 */
export async function startApp(options: { config?: Partial<Config>; githubFetch?: typeof fetch; mcpFetch?: typeof fetch; now?: () => Date; harnesses?: Harnesses } = {}): Promise<TestApp> {
  const config = tempConfig(options.config);
  const app = createApp({ config, githubFetch: options.githubFetch ?? noNetwork, mcpFetch: options.mcpFetch ?? noNetwork, now: options.now, heartbeatMs: 60_000, harnesses: options.harnesses ?? { claude: fakeHarness() } });
  const addr = await app.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return {
    app,
    base,
    config,
    api,
    async json(path, init) {
      const res = await api(path, init);
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${path}: ${text}`);
      return text ? JSON.parse(text) : undefined;
    },
    async close() {
      await app.close();
      rmSync(join(config.home, ".."), { recursive: true, force: true });
    },
  };
}

/** Reads SSE frames from /api/events until `until` returns true or the timeout passes. */
export async function collectEvents(base: string, until: (events: ServerEvent[]) => boolean, timeoutMs = 2000): Promise<ServerEvent[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events: ServerEvent[] = [];
  try {
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
      if (until(events)) break;
    }
  } catch (err) {
    if (!ctrl.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return events;
}

/** A full Services object for route/unit tests: the given fakes, and loud stubs for everything else. */
export function stubServices(partial: Partial<Services>): Services {
  return Object.fromEntries(SERVICE_NAMES.map((n) => [n, partial[n] ?? notImplemented(n)])) as unknown as Services;
}
