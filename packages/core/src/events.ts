// In-process event bus. The runner and the HTTP handlers publish ServerEvents; the SSE hub fans them out.
import type { ServerEvent } from "@odin/shared/events";

export type EventListener = (event: ServerEvent) => void;

export class EventBus {
  #listeners = new Set<EventListener>();
  #held: ServerEvent[] | null = null;

  emit(event: ServerEvent): void {
    if (this.#held) {
      this.#held.push(event);
      return;
    }
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("event listener failed:", err);
      }
    }
  }

  /**
   * Runs fn with events held back: they go out after fn returns (so clients never see state from a transaction that
   * later rolls back) and are dropped if it throws. Nested batches join the outer one.
   */
  batch<T>(fn: () => T): T {
    if (this.#held) return fn();
    this.#held = [];
    let out: T;
    try {
      out = fn();
    } catch (err) {
      this.#held = null;
      throw err;
    }
    const held = this.#held;
    this.#held = null;
    for (const event of held) this.emit(event);
    return out;
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}
