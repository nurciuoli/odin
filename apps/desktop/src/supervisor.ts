// Runs an owned core: spawn, wait for health, restart with backoff on unexpected exit, graceful stop on quit.
// Never used for an attached core.
import type { Readable } from "node:stream";
import { restartPolicy, type RestartPolicy } from "./backoff.ts";
import { realClock, waitForHealth, type Clock, type ProbeResult } from "./health.ts";

export interface CoreChild {
  stdout: Readable | null;
  stderr: Readable | null;
  send?(msg: unknown): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", fn: (err: Error) => void): unknown;
}

export interface SupervisorDeps {
  spawnCore(): CoreChild;
  check(): Promise<ProbeResult>;
  log: { write(chunk: string | Buffer): void; line(msg: string): void };
  clock?: Clock;
  policy?: RestartPolicy;
  healthTimeoutMs?: number;
  stopTimeoutMs?: number;
  onHealthy(): void;
  /** Restarts exhausted (or the very first start never became healthy and restarts ran out). */
  onGaveUp(reason: string): void;
}

export interface Supervisor {
  start(): Promise<void>;
  /** Manual restart from the error window: clears the backoff history. */
  restart(): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
}

export function supervisor(deps: SupervisorDeps): Supervisor {
  const clock = deps.clock ?? realClock;
  const policy = deps.policy ?? restartPolicy();
  const stopTimeoutMs = deps.stopTimeoutMs ?? 10_000;
  let child: CoreChild | null = null;
  let exited: Promise<void> = Promise.resolve();
  let stopping = false;
  let generation = 0;

  const launch = async (): Promise<void> => {
    const gen = ++generation;
    const c = deps.spawnCore();
    child = c;
    c.stdout?.on("data", (d: Buffer) => deps.log.write(d));
    c.stderr?.on("data", (d: Buffer) => deps.log.write(d));
    let isExited = false;
    exited = new Promise((resolve) => {
      let done = false;
      const finish = (why: string) => {
        if (done) return;
        done = true;
        isExited = true;
        if (child === c) child = null;
        resolve();
        if (!stopping && gen === generation) {
          deps.log.line(`core exited (${why})`);
          void scheduleRestart(why);
        }
      };
      c.once("exit", (code, signal) => finish(signal ? `signal ${signal}` : `code ${code}`));
      c.once("error", (err) => finish(`spawn error: ${err.message}`));
    });
    deps.log.line("core started");
    const ok = await waitForHealth(deps.check, {
      timeoutMs: deps.healthTimeoutMs ?? 20_000,
      clock,
      abort: () => isExited || stopping || gen !== generation,
    });
    if (gen !== generation || stopping || isExited) return;
    if (ok) {
      deps.onHealthy();
    } else {
      deps.log.line("core did not become healthy in time; killing it");
      c.kill(); // the exit handler schedules the restart
    }
  };

  const scheduleRestart = async (why: string) => {
    const delay = policy.next(clock.now());
    if (delay === null) {
      deps.log.line("core keeps exiting; giving up until a manual restart");
      deps.onGaveUp(`Core stopped unexpectedly (${why}) and kept failing to restart.`);
      return;
    }
    const gen = generation;
    await clock.sleep(delay);
    if (stopping || gen !== generation) return;
    await launch();
  };

  const stop = async () => {
    stopping = true;
    generation++;
    const c = child;
    if (!c) return;
    deps.log.line("stopping core");
    try {
      c.send?.({ type: "shutdown" });
    } catch {
      // IPC channel already closed: fall through to the timeout and kill.
    }
    const timedOut = await Promise.race([exited.then(() => false), clock.sleep(stopTimeoutMs).then(() => true)]);
    if (timedOut) {
      deps.log.line("core did not stop in time; killing it");
      c.kill("SIGKILL");
      await exited;
    }
  };

  return {
    start: () => {
      stopping = false;
      return launch();
    },
    restart: async () => {
      await stop();
      policy.reset();
      stopping = false;
      await launch();
    },
    stop,
    get running() {
      return child !== null;
    },
  };
}
