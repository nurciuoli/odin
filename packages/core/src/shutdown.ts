// Clean shutdown triggers (docs/contracts.md#desktop-shell): SIGINT/SIGTERM, and on Windows (no SIGTERM) a Node IPC
// message `{ type: "shutdown" }` from the desktop shell that spawned core. Every trigger runs the same close (live
// handles) once, then exits 0. An IPC disconnect is ignored: an attached or orphaned core keeps running.

/** The slice of `process` this needs, so tests can pass an EventEmitter. */
export interface ShutdownProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send?: unknown;
}

export function isShutdownMessage(msg: unknown): boolean {
  return typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "shutdown";
}

export function installShutdownHandlers(proc: ShutdownProcess, close: () => Promise<unknown>, exit: (code: number) => void): void {
  let closing: Promise<void> | null = null;
  const shutdown = (): void => {
    closing ??= close().then(() => {}, () => {}).finally(() => exit(0));
  };
  for (const sig of ["SIGINT", "SIGTERM"]) proc.on(sig, shutdown);
  if (typeof proc.send === "function") {
    proc.on("message", (msg) => {
      if (isShutdownMessage(msg)) shutdown();
    });
    proc.on("disconnect", () => {});
  }
}
