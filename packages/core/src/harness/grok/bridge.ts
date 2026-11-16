// Loopback bridge from the host-tool MCP child back to in-process handlers.
import { createServer, type Server, type Socket } from "node:net";
import type { HostTool } from "../types.ts";
import { boundHostToolResult } from "../host-result.ts";

export interface HostBridge {
  port: number;
  close(): Promise<void>;
}

export function startHostBridge(tools: HostTool[], maxFrameBytes = 8 * 1024 * 1024): Promise<HostBridge> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > maxFrameBytes) { socket.destroy(); return; }
        if (!line.trim()) continue;
        void answer(socket, line);
      }
      if (Buffer.byteLength(buffer) > maxFrameBytes) socket.destroy();
    });
  });
  function definitions() {
    return tools.map(({ name, description, params }) => ({ name, description, params }));
  }
  function write(socket: Socket, value: unknown) {
    if (socket.destroyed || !socket.writable) return;
    const encoded = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(encoded) > maxFrameBytes) { socket.destroy(); return; }
    socket.write(encoded);
  }
  async function answer(socket: Socket, line: string) {
    let request: { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try {
      request = JSON.parse(line);
      if (!request || typeof request !== "object" || typeof request.id !== "number") { socket.destroy(); return; }
    } catch {
      socket.destroy();
      return;
    }
    try {
      if (request.method === "tools/list") {
        write(socket, { id: request.id, result: definitions() });
        return;
      }
      if (request.method === "tools/call") {
        const tool = tools.find((item) => item.name === request.params?.name);
        if (!tool) throw new Error("Unknown tool");
        const result = await tool.handler(request.params?.arguments ?? {});
        write(socket, { id: request.id, result: boundHostToolResult(result) });
        return;
      }
      write(socket, { id: request.id, error: "Unknown method" });
    } catch (error) {
      write(socket, { id: request.id, error: "Host tool failed" });
    }
  }
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Host bridge failed to bind"));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
