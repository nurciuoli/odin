// Antigravity ACP transport. JSON-RPC on stdin/stdout. No SDK, no shell, no credential reads.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { toolOverride } from "../../tools/resolve.ts";

export type Wire = Record<string, any>;

export interface Rpc {
  request(method: string, params?: Wire, timeoutMs?: number): Promise<Wire>;
  respond(id: string | number, result: Wire): void;
  notify(method: string, params?: Wire): void;
  reject(id: string | number, message: string): void;
  onMessage: (message: Wire) => void;
  onExit: (error: Error | null) => void;
  close(): void;
}

const AGENT_ARGS = ["acp", "--stdio"];

/** A JSON-RPC error the user can read. */
export function antigravityRpcError(error: { code?: unknown; message?: unknown; data?: unknown }): Error {
  const code = typeof error?.code === "number" || typeof error?.code === "string" ? String(error.code) : "unknown";
  const message = typeof error?.message === "string" && error.message.trim() ? error.message.trim() : "Antigravity request failed";
  const data = typeof error?.data === "string" ? error.data.trim() : "";
  const detail = data && !message.includes(data) ? `${message}: ${data}` : message;
  return new Error(`${detail.replace(/\s+/g, " ").slice(0, 240)} (${code})`);
}

/** Resolve the antigravity/agy binary: Settings override, else a PATH search. Null when neither finds it. */
export function antigravityBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string | null {
  const override = toolOverride("antigravity");
  if (override) return override;
  const path = env.PATH ?? env.Path ?? "";
  const names = platform === "win32" ? ["agy.exe", "antigravity.exe"] : ["agy", "antigravity"];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const binary = join(dir, name);
      if (existsSync(binary)) return binary;
    }
  }
  return null;
}

export function antigravityCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): { command: string; args: string[] } | null {
  const command = antigravityBinary(env, platform);
  return command ? { command, args: AGENT_ARGS } : null;
}

export function scrubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.GITHUB_TOKEN;
  delete next.GH_TOKEN;
  delete next.ODIN_INGEST_TOKEN;
  return next;
}

export async function antigravityVersion(command: string, run = execFile): Promise<void> {
  await promisify(run)(command, ["--help"], { timeout: 8_000, windowsHide: true });
}

export function connectAntigravity(timeoutMs = 30_000): Rpc {
  const spec = antigravityCommand();
  if (!spec) throw new Error("Antigravity CLI is not installed");
  const child = spawn(spec.command, spec.args, {
    env: scrubEnv(),
    windowsHide: true,
    stdio: "pipe",
  });
  return attachAntigravity(child, timeoutMs);
}

export function attachAntigravity(child: ChildProcessWithoutNullStreams, timeoutMs = 30_000): Rpc {
  let next = 0;
  let ended = false;
  let buffer = "";
  const pending = new Map<number, { resolve: (value: Wire) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  function finish(error: Error | null) {
    if (ended) return;
    ended = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error ?? new Error("Antigravity connection closed"));
    }
    pending.clear();
    rpc.onExit(error);
  }

  function write(message: Wire) {
    if (ended) throw new Error("Antigravity connection closed");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  const rpc: Rpc = {
    onMessage: () => {},
    onExit: () => {},
    request(method, params = {}, timeout = timeoutMs) {
      if (ended) return Promise.reject(new Error("Antigravity connection closed"));
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Antigravity ${method} timed out`));
        }, timeout);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          write({ id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    respond(id, result) {
      try {
        write({ id, result });
      } catch {
        /* Already closed */
      }
    },
    reject(id, message) {
      try {
        write({ id, error: { code: -32000, message } });
      } catch {
        /* Already closed */
      }
    },
    notify(method, params = {}) {
      try {
        write({ method, params });
      } catch {
        /* Already closed */
      }
    },
    close() {
      if (ended) return;
      ended = true;
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Antigravity connection closed"));
      }
      pending.clear();
      try {
        child.kill();
      } catch {
        /* Ignore */
      }
    },
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: Wire;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      // `null`, a number or an array is valid JSON but not a message; skip it rather than throw inside the stream handler.
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      if (typeof message.id === "number" && pending.has(message.id)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(antigravityRpcError(message.error));
        else waiter.resolve(message.result ?? {});
      } else {
        try {
          rpc.onMessage(message);
        } catch {
          // One bad event must not take the server down or end the session.
        }
      }
    }
  });

  // Drain diagnostics so a full pipe never stalls the agent; they aren't logged (they may hold user config).
  child.stderr?.resume();
  // A write to a dead process is an 'error' event on stdin: unhandled, it would crash the server.
  child.stdin.on("error", () => finish(new Error("Antigravity input closed")));
  child.on("error", (error) => finish(error));
  child.on("close", (code) => finish(ended ? null : new Error(`Antigravity exited (${code ?? "signal"})`)));
  return rpc;
}
