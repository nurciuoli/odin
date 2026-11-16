/** A single-consumer async queue. Ending drains buffered entries and refuses new ones. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;
  get ended(): boolean { return this.done; }
  push(item: T): void {
    if (this.done) return;
    if (this.waiting) { const next = this.waiting; this.waiting = null; next({ value: item, done: false }); }
    else this.items.push(item);
  }
  end(): void {
    if (this.done) return;
    this.done = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.items.length
      ? Promise.resolve({ value: this.items.shift()!, done: false })
      : this.done ? Promise.resolve({ value: undefined, done: true })
      : new Promise(resolve => { this.waiting = resolve; }) };
  }
}
