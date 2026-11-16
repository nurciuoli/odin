// <home>/desktop.log: core stdout/stderr plus the shell's own lines. Rotated at 5 MB, one previous file kept.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface RotatingLog {
  write(chunk: string | Buffer): void;
  line(msg: string): void;
  readonly file: string;
}

export function rotatingLog(file: string, opts: { maxBytes?: number; now?: () => Date } = {}): RotatingLog {
  const maxBytes = opts.maxBytes ?? MAX_LOG_BYTES;
  const now = opts.now ?? (() => new Date());
  mkdirSync(dirname(file), { recursive: true });
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  const write = (chunk: string | Buffer) => {
    const len = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    if (size > 0 && size + len > maxBytes) {
      rmSync(file + ".1", { force: true });
      try {
        renameSync(file, file + ".1");
      } catch {
        // Another process may hold it; keep appending rather than lose output.
      }
      size = 0;
    }
    try {
      appendFileSync(file, chunk);
      size += len;
    } catch {
      // Logging must never take the shell down.
    }
  };
  return {
    file,
    write,
    line: (msg) => write(`[${now().toISOString()}] [desktop] ${msg}\n`),
  };
}
