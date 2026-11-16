// Stdio MCP server for Odin host tools. The parent owns the handlers on a loopback port.
import { hostToolSchema } from "../host-schema.ts";
import { createInterface } from "node:readline";
import { connect } from "node:net";
import { pathToFileURL } from "node:url";
import { mcpHostContent } from "../host-result.ts";
import type { HostToolResult } from "../types.ts";

export interface HostDefinition {
  name: string;
  description: string;
  params: Record<string, { type: string; description: string; optional?: boolean }>;
}

type Parent = (message: { id: number; method: string; params?: Record<string, unknown> }) => Promise<{ result?: unknown; error?: string }>;

export async function handleMcp(
  message: { id?: string | number; method: string; params?: Record<string, unknown> },
  parent: Parent,
): Promise<Record<string, unknown> | null> {
  if (message.id === undefined) return null;
  try {
    if (message.method === "initialize") {
      return { jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "odin", version: "1.0.0" } } };
    }
    if (message.method === "ping" || message.method === "notifications/initialized") {
      return message.method === "ping" ? { jsonrpc: "2.0", id: message.id, result: {} } : null;
    }
    if (message.method === "tools/list") {
      const listed = await parent({ id: 1, method: "tools/list" });
      if (listed.error) throw new Error(listed.error);
      const definitions = Array.isArray(listed.result) ? listed.result as HostDefinition[] : [];
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: definitions.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: hostToolSchema(tool.params),
          })),
        },
      };
    }
    if (message.method === "tools/call") {
      const name = message.params?.name;
      if (typeof name !== "string" || !/^[a-z_]+$/.test(name)) throw new Error("Invalid tool name");
      const called = await parent({ id: 1, method: "tools/call", params: { name, arguments: (message.params?.arguments ?? {}) as Record<string, unknown> } });
      if (called.error) throw new Error(called.error);
      const answer = called.result as HostToolResult;
      return { jsonrpc: "2.0", id: message.id, result: { content: mcpHostContent(answer), ...(answer?.isError ? { isError: true } : {}) } };
    }
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } };
  } catch (error) {
    return { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : "Host tool failed" } };
  }
}

/** Closeable bridge client: disconnects and malformed frames reject every outstanding call. */
export function parentClient(port: number, timeoutMs = 10 * 60_000, maxFrameBytes = 8 * 1024 * 1024): Parent & { close(): void } {
  const socket = connect({ host: "127.0.0.1", port });
  let buffer = "";
  let next = 0;
  let failure: Error | null = null;
  const pending = new Map<number, { resolve: (value: { result?: unknown; error?: string }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  function stop(error: Error) {
    if (failure) return;
    failure = error;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
    socket.destroy();
  }
  socket.on("error", () => stop(new Error("Host bridge connection failed")));
  socket.on("close", () => stop(new Error("Host bridge connection closed")));
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxFrameBytes) { stop(new Error("Host bridge frame too large")); return; }
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        if (!message || typeof message !== "object" || typeof message.id !== "number") throw new Error();
        const waiter = pending.get(message.id);
        if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); waiter.resolve(message); }
      } catch { stop(new Error("Invalid host bridge response")); return; }
    }
    if (Buffer.byteLength(buffer) > maxFrameBytes) stop(new Error("Host bridge frame too large"));
  });
  const parent: Parent = (message) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++next;
    const encoded = JSON.stringify({ ...message, id }) + "\n";
    if (Buffer.byteLength(encoded) > maxFrameBytes) { reject(new Error("Host bridge frame too large")); return; }
    const timer = setTimeout(() => stop(new Error("Host bridge request timed out")), timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.write(encoded, error => { if (error) stop(new Error("Host bridge write failed")); });
  });
  return Object.assign(parent, { close: () => stop(new Error("Host bridge connection closed")) });
}

async function main() {
  const index = process.argv.indexOf("--port");
  const port = Number(index >= 0 ? process.argv[index + 1] : "");
  if (!Number.isInteger(port) || port <= 0) throw new Error("Pass --port");
  const parent = parentClient(port);
  try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const result = await handleMcp(JSON.parse(line), parent);
      if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } })}\n`);
    }
  }
  } finally { parent.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Host MCP failed"}\n`);
    process.exitCode = 1;
  });
}
