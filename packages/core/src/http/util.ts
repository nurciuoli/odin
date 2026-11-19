import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

export class HttpError extends Error {
  readonly status: number;
  /** A machine-readable reason sent as `code` next to `error` (git routes use GitErrorCode). */
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_JSON_BYTES = 1024 * 1024;

export function readBody(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        // Drain instead of destroying, so the client gets the 413 rather than a reset socket.
        req.off("data", onData);
        req.resume();
        reject(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<any> {
  const raw = (await readBody(req, limit)).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined || status === 204) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, error: string, code?: string): void {
  send(res, status, code ? { error, code } : { error });
}

/** Constant-time compare for the ingest token. */
export function tokenOk(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
