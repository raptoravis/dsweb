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
  /** Count of live `follow` streams; a busy user is never recycled. */
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
 * loses a conversation.
 */
export class ProcessManager implements DshService {
  private users = new Map<string, ManagedUser>();
  private closed = false;

  constructor(
    private readonly factory: DshAdapterFactory,
    private readonly options: ProcessManagerOptions,
  ) {}

  private userHome(userId: string): string {
    return join(this.options.homeBase, userId);
  }

  private async acquire(userId: string): Promise<ManagedUser> {
    const existing = this.users.get(userId);
    if (existing) {
      this.touch(existing);
      return existing;
    }
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
      // Busy: re-arm and defer; recycle on next idle tick.
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

  async prompt(userId: string, sessionId: string, content: string): Promise<void> {
    const managed = await this.acquire(userId);
    await managed.adapter.prompt(sessionId, content);
  }

  async *follow(userId: string, sessionId: string): AsyncIterable<DshEvent> {
    const managed = await this.acquire(userId);
    managed.inflight++;
    this.touch(managed);
    try {
      yield* managed.adapter.follow(sessionId);
    } finally {
      managed.inflight--;
      this.touch(managed);
    }
  }

  async closeAll(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const adapters = [...this.users.values()].map((m) => m.adapter);
    this.users.clear();
    await Promise.all(adapters.map((a) => a.close().catch(() => {})));
  }

  /** Number of live managed runtimes (exposed for lifecycle tests). */
  liveCount(): number {
    return this.users.size;
  }
}
