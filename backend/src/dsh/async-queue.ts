/**
 * Minimal push-based async queue: producers `push` events, a consumer
 * `[Symbol.asyncIterator]` drains them in order until `close()`. Buffers
 * events pushed before a consumer attaches, so a producer that outpaces its
 * subscriber loses nothing.
 */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.items.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) waiter({ done: true, value: undefined });
    this.waiters = [];
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return Promise.resolve({ done: false, value: this.items.shift()! });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
