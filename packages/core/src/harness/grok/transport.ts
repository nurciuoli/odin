// Grok Build ACP transport. JSON-RPC on stdin/stdout. No SDK, no shell, no credential reads.
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

const AGENT_ARGS = ["--no-auto-update", "agent", "--no-leader", "stdio"];

/** A JSON-RPC error the user can read. The code stays; the message and a short data string say why. */
export function grokRpcError(error: { code?: unknown; message?: unknown; data?: unknown }): Error {
  const code = typeof error?.code === "number" || typeof error?.code === "string" ? String(error.code) : "unknown";
  const message = typeof error?.message === "string" && error.message.trim() ? error.message.trim() : "Grok request failed";
  const data = typeof error?.data === "string" ? error.data.trim() : "";
  const detail = data && !message.includes(data) ? `${message}: ${data}` : message;
  return new Error(`${detail.replace(/\s+/g, " ").slice(0, 240)} (${code})`);
}

/** Resolve the grok binary: the Settings override, else a PATH search. Null when neither finds it. */
export function grokBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string | null {
  const override = toolOverride("grok");
  if (override) return override;
  const path = env.PATH ?? env.Path ?? "";
  if (platform === "win32") {
    for (const dir of path.split(delimiter)) {
      const binary = join(dir, "grok.exe");
      if (dir && existsSync(binary)) return binary;
    }
    return null;
  }
  for (const dir of path.split(delimiter)) {
    const binary = join(dir, "grok");
    if (dir && existsSync(binary)) return binary;
  }
  return null;
}

export function grokCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): { command: string; args: string[] } | null {
  const command = grokBinary(env, platform);
  return command ? { command, args: AGENT_ARGS } : null;
}

export function scrubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.GITHUB_TOKEN;
  delete next.GH_TOKEN;
  delete next.ODIN_INGEST_TOKEN;
  return next;
}

export async function grokVersion(command: string, run = execFile): Promise<void> {
  await promisify(run)(command, ["--version"], { timeout: 8_000, windowsHide: true });
}

export function connectGrok(timeoutMs = 30_000): Rpc {
  const spec = grokCommand();
  if (!spec) throw new Error("Grok Build is not installed");
  const child = spawn(spec.command, spec.args, {
    env: scrubEnv(),
    windowsHide: true,
    stdio: "pipe",
  });
  return attachGrok(child, timeoutMs);
}

export function attachGrok(child: ChildProcessWithoutNullStreams, timeoutMs = 30_000): Rpc {
  let next = 0;
  let ended = false;
  let buffer = "";
  const pending = new Map<number, { resolve: (value: Wire) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  function finish(error: Error | null) {
    if (ended) return;
    ended = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error ?? new Error("Grok connection closed"));
    }
    pending.clear();
    rpc.onExit(error);
  }
  function write(message: Wire) {
    if (ended) throw new Error("Grok connection closed");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }
  const rpc: Rpc = {
    onMessage: () => {},
    onExit: () => {},
    request(method, params = {}, timeout = timeoutMs) {
      if (ended) return Promise.reject(new Error("Grok connection closed"));
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Grok ${method} timed out`));
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
    respond: (id, result) => write({ id, result }),
    notify: (method, params = {}) => write({ method, params }),
    reject: (id, message) => write({ id, error: { code: -32603, message } }),
    close() {
      child.stdin.end();
      child.kill();
      finish(null);
    },
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024) {
      child.kill();
      finish(new Error("Grok protocol frame too large"));
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: Wire;
      try {
        message = JSON.parse(line);
      } catch {
        child.kill();
        finish(new Error("Invalid Grok protocol JSON"));
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        child.kill();
        finish(new Error("Invalid Grok protocol message"));
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter && !message.method) {
        clearTimeout(waiter.timer);
        pending.delete(message.id);
        if (message.error) waiter.reject(grokRpcError(message.error));
        else waiter.resolve(message.result ?? {});
      } else {
        try {
          rpc.onMessage(message);
        } catch {
          child.kill();
          finish(new Error("Invalid Grok event payload"));
          return;
        }
      }
    }
  });
  // Stderr can echo local config. Drain it and do not return it.
  child.stderr.resume();
  child.stdin.on("error", () => finish(new Error("Grok input closed")));
  child.on("error", () => finish(new Error("Grok Build is not installed or could not start")));
  child.on("exit", (code) => finish(ended ? null : new Error(`Grok exited (${code ?? "signal"})`)));
  return rpc;
}
