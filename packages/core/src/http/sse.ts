// GET /api/events: one stream per tab, everything from the event bus, plus heartbeats.
import type { IncomingMessage, ServerResponse } from "node:http";
import { HEARTBEAT_MS, type ServerEvent } from "@odin/shared/events";
import type { EventBus } from "../events.ts";

export function frame(event: ServerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class SseHub {
  #clients = new Set<ServerResponse>();
  #unsubscribe: () => void;
  #timer: NodeJS.Timeout;

  constructor(bus: EventBus, heartbeatMs = HEARTBEAT_MS) {
    this.#unsubscribe = bus.subscribe((event) => this.broadcast(event));
    this.#timer = setInterval(() => this.broadcast({ type: "heartbeat", at: new Date().toISOString() }), heartbeatMs);
    this.#timer.unref();
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    res.write(frame({ type: "heartbeat", at: new Date().toISOString() }));
    this.#clients.add(res);
    const drop = () => this.#clients.delete(res);
    req.on("close", drop);
    res.on("close", drop);
    res.on("error", drop);
  }

  broadcast(event: ServerEvent): void {
    if (this.#clients.size === 0) return;
    const data = frame(event);
    for (const res of this.#clients) {
      if (res.destroyed || res.writableEnded) {
        this.#clients.delete(res);
        continue;
      }
      res.write(data);
    }
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  close(): void {
    clearInterval(this.#timer);
    this.#unsubscribe();
    for (const res of this.#clients) res.end();
    this.#clients.clear();
  }
}
