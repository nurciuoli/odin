/** Keep events received during a REST snapshot, then replay them after installing that snapshot. */
export function snapshotJournal<Event>() {
  let generation = 0;
  let held: Event[] | null = null;
  return {
    begin() {
      held = [];
      return ++generation;
    },
    observe(event: Event) { held?.push(event); },
    complete(token: number, install: () => void, replay: (event: Event) => void) {
      if (token !== generation) return false;
      const events = held ?? [];
      held = null;
      install();
      for (const event of events) replay(event);
      return true;
    },
    cancel(token: number) { if (token === generation) held = null; },
  };
}

/** Initialize shell affordances once; retry connection/startup without registering them again. */
export function startupController(initialize: () => void, connect: () => Promise<void>) {
  let initialized = false;
  let pending: Promise<void> | null = null;
  return () => {
    if (pending) return pending;
    pending = Promise.resolve().then(() => {
      if (!initialized) {
        initialize();
        initialized = true;
      }
      return connect();
    }).finally(() => { pending = null; });
    return pending;
  };
}
