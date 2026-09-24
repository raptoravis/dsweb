import { join } from "node:path";
import type {
  DshAdapter,
  DshAdapterFactory,
  DshEvent,
  DshService,
} from "./types.js";

interface ManagedUser {
  adapter: DshAdapter;
  lastActive: number;
  timer: NodeJS.Timeout | null;
  /** Count of live turns; a busy user is never recycled. */
  inflight: number;
}

export interface ProcessManagerOptions {
  idleTimeoutMs: number;
  maxConcurrent: number;
  homeBase: string;
}

/**
 * Owns the lifecycle of one dsh process per active user: lazily spawns on
 * first use, recycles after idle timeout, and relaunches on the next use.
 * History lives in the backend DB (or the shared fake store), so recycle never
 * loses a conversation. Turns on the same session are serialized so a shared
 * runtime's event queue is never consumed by two streams at once.
 */
export class ProcessManager implements DshService {
  private users = new Map<string, ManagedUser>();
  private pending = new Map<string, Promise<ManagedUser>>();
  private turnTails = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly factory: DshAdapterFactory,
    private readonly options: ProcessManagerOptions,
  ) {}

  private userHome(userId: string): string {
    return join(this.options.homeBase, userId);
  }

  /** Lazily spawn (or reuse) the runtime for a user, deduplicating concurrent creates. */
  private acquire(userId: string): Promise<ManagedUser> {
    const existing = this.users.get(userId);
    if (existing) {
      this.touch(existing);
      return Promise.resolve(existing);
    }
    const inflight = this.pending.get(userId);
    if (inflight) return inflight;
    const promise = this.createManaged(userId).finally(() => {
      this.pending.delete(userId);
    });
    this.pending.set(userId, promise);
    return promise;
  }

  private async createManaged(userId: string): Promise<ManagedUser> {
    await this.evictIfNeeded();
    const adapter = await this.factory.create(this.userHome(userId));
    const managed: ManagedUser = {
      adapter,
      lastActive: Date.now(),
      timer: null,
      inflight: 0,
    };
    this.users.set(userId, managed);
    this.touch(managed);
    return managed;
  }

  /** Recycle least-recently-active idle users until there is room. */
  private async evictIfNeeded(): Promise<void> {
    while (this.users.size >= this.options.maxConcurrent) {
      const victim = [...this.users.entries()]
        .filter(([, m]) => m.inflight === 0)
        .sort((a, b) => a[1].lastActive - b[1].lastActive)[0];
      if (!victim) return; // everyone busy — allow overshoot rather than block
      const [id, managed] = victim;
      this.users.delete(id);
      if (managed.timer) clearTimeout(managed.timer);
      await managed.adapter.close().catch(() => {});
    }
  }

  private touch(managed: ManagedUser): void {
    managed.lastActive = Date.now();
    if (managed.timer) clearTimeout(managed.timer);
    managed.timer = setTimeout(() => {
      void this.recycle(managed);
    }, this.options.idleTimeoutMs);
    managed.timer.unref?.();
  }

  private async recycle(managed: ManagedUser): Promise<void> {
    if (managed.inflight > 0) {
      // Busy: re-arm and defer; recycle on the next idle tick.
      this.touch(managed);
      return;
    }
    for (const [id, m] of this.users) {
      if (m === managed) {
        this.users.delete(id);
        break;
      }
    }
    if (managed.timer) clearTimeout(managed.timer);
    await managed.adapter.close().catch(() => {});
  }

  async *turn(userId: string, sessionId: string, content: string): AsyncIterable<DshEvent> {
    const managed = await this.acquire(userId);

    // Serialize turns per session: wait for the previous turn on this session
    // to finish before enqueuing + streaming the next one.
    const key = `${userId}\u0000${sessionId}`;
    const previous = this.turnTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.turnTails.set(key, gate);
    await previous;

    managed.inflight++;
    this.touch(managed);
    try {
      yield* managed.adapter.turn(sessionId, content);
    } finally {
      managed.inflight--;
      this.touch(managed);
      release();
    }
  }

  async closeAll(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const adapters = [...this.users.values()].map((m) => m.adapter);
    this.users.clear();
    this.pending.clear();
    this.turnTails.clear();
    await Promise.all(adapters.map((a) => a.close().catch(() => {})));
  }

  /** Number of live managed runtimes (exposed for lifecycle tests). */
  liveCount(): number {
    return this.users.size;
  }
}
