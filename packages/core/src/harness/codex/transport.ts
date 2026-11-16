// Codex app-server JSONL transport. No SDK dependency, shell, login handling, or credential reads.
import { projectDirectories as nativeProjectDirectories } from "../directories.ts";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { gitBinary, toolOverride } from "../../tools/resolve.ts";

export type Wire = Record<string, any>;
export interface Rpc {
  request(method: string, params?: Wire): Promise<Wire>;
  respond(id: string | number, result: Wire): void;
  notify(method: string, params?: Wire): void;
  reject(id: string | number, message: string): void;
  onMessage: (message: Wire) => void;
  onExit: (error: Error | null) => void;
  close(): void;
}

export function wslPath(path: string): string {
  if (path.startsWith("/")) return path;
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (drive)
    return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, "/")}`;
  const unc = /^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+(\\.*)$/i.exec(path);
  if (unc) return unc[1]!.replace(/\\/g, "/");
  throw new Error("WSL requires an absolute Windows drive path or WSL path");
}

export function fromWslPath(value: string, projectPath: string): string {
  const unc = /^\\\\((?:wsl\$|wsl\.localhost)\\[^\\]+)/i.exec(projectPath);
  if (unc && value.startsWith("/"))
    return `\\\\${unc[1]}${value.replace(/\//g, "\\")}`;
  const drive = /^\/mnt\/([a-z])\/(.*)$/.exec(value);
  if (drive) return `${drive[1]!.toUpperCase()}:/${drive[2]}`;
  throw new Error(
    "The WSL session path is not accessible from Windows; register its project via a WSL UNC path",
  );
}

export async function projectDirectories(
  projectPath: string,
  wsl = false,
): Promise<string[]> {
  if (!wsl) return nativeProjectDirectories(projectPath);
  const root = wslPath(projectPath);
  try {
    const command = codexCommand(
      wsl,
      process.env,
      process.platform,
      projectPath,
    );
    const args = ["-C", root, "worktree", "list", "--porcelain"];
    const result = await promisify(execFile)(
      wsl ? command.command : gitBinary(),
      wsl ? [...command.args.slice(0, -2), "git", ...args] : args,
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
    );
    return [
      ...new Set([
        root,
        ...result.stdout
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice(9)),
      ]),
    ];
  } catch {
    return [root];
  }
}

/** npm installs expose .cmd shims on Windows; run their JS entry with Node and argv instead of a shell. */
export function codexCommand(
  wsl = false,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  cwd?: string,
): { command: string; args: string[] } {
  if (wsl) {
    const distribution = cwd
      ? /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)/i.exec(cwd)?.[1]
      : undefined;
    return {
      command: "wsl.exe",
      args: [
        ...(distribution ? ["--distribution", distribution] : []),
        "--exec",
        "codex",
        "app-server",
      ],
    };
  }
  // A Settings override (a host path) wins over the PATH search; it does not apply inside WSL.
  const override = toolOverride("codex");
  if (override) return { command: override, args: ["app-server"] };
  if (platform === "win32") {
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
      const binary = join(dir, "codex.exe");
      if (existsSync(binary)) return { command: binary, args: ["app-server"] };
      const entry = join(
        dir,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );
      if (existsSync(entry)) {
        const triple =
          process.arch === "arm64"
            ? "aarch64-pc-windows-msvc"
            : "x86_64-pc-windows-msvc";
        const roots = [join(dirname(entry), "..", "vendor")];
        try {
          roots.unshift(
            join(
              dirname(
                createRequire(entry).resolve(
                  `@openai/codex-win32-${process.arch}/package.json`,
                ),
              ),
              "vendor",
            ),
          );
        } catch {
          /* Older CLI bundles vendor directly. */
        }
        for (const root of roots)
          for (const bin of ["bin", "codex"]) {
            const executable = join(root, triple, bin, "codex.exe");
            if (existsSync(executable))
              return { command: executable, args: ["app-server"] };
          }
      }
    }
  }
  return { command: "codex", args: ["app-server"] };
}

export function connectCodex(
  wsl = false,
  timeoutMs = 30_000,
  cwd?: string,
): Rpc {
  const spec = codexCommand(wsl, process.env, process.platform, cwd);
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.ODIN_INGEST_TOKEN;
  const child: ChildProcessWithoutNullStreams = spawn(spec.command, spec.args, {
    env,
    windowsHide: true,
    stdio: "pipe",
  });
  return attachCodex(child, timeoutMs);
}

export function attachCodex(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 30_000,
): Rpc {
  let next = 0;
  let ended = false;
  let buffer = "";
  const pending = new Map<
    number,
    {
      resolve: (value: Wire) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function finish(error: Error | null) {
    if (ended) return;
    ended = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error ?? new Error("Codex connection closed"));
    }
    pending.clear();
    rpc.onExit(error);
  }
  function write(message: Wire) {
    if (ended) throw new Error("Codex connection closed");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  const rpc: Rpc = {
    onMessage: () => {},
    onExit: () => {},
    request(method, params = {}) {
      if (ended) return Promise.reject(new Error("Codex connection closed"));
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex ${method} timed out`));
        }, timeoutMs);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        try {
          write({ id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    respond: (id, result) => write({ id, result }),
    notify: (method, params = {}) => write({ method, params }),
    reject: (id, message) => write({ id, error: { code: -32601, message } }),
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
      finish(new Error("Codex protocol frame too large"));
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
        finish(new Error("Invalid Codex protocol JSON"));
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        child.kill();
        finish(new Error("Invalid Codex protocol message"));
        return;
      }
      const p = pending.get(message.id);
      if (p && !message.method) {
        clearTimeout(p.timer);
        pending.delete(message.id);
        if (message.error)
          p.reject(
            new Error(
              `Codex request failed (${message.error.code ?? "unknown"})`,
            ),
          );
        else p.resolve(message.result ?? {});
      } else {
        try {
          rpc.onMessage(message);
        } catch {
          child.kill();
          finish(new Error("Invalid Codex event payload"));
          return;
        }
      }
    }
  });
  // Drain diagnostics without exposing process output (which may include user config) to API responses or logs.
  child.stderr.resume();
  child.stdin.on("error", () => finish(new Error("Codex input closed")));
  child.on("error", () =>
    finish(new Error("Codex is not installed or could not start")),
  );
  child.on("exit", (code) =>
    finish(ended ? null : new Error(`Codex exited (${code ?? "signal"})`)),
  );
  return rpc;
}

export async function initialize(rpc: Rpc): Promise<void> {
  await rpc.request("initialize", {
    clientInfo: { name: "odin", title: "Odin", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized");
}
