import { resolve } from "node:path";

/**
 * Runtime configuration, resolved once at process start from the environment.
 * Every value has a sane default so the server boots with no configuration
 * beyond an optional DeepSeek key.
 */
export interface Config {
  port: number;
  /** Path to the backend SQLite database. */
  dbPath: string;
  /** Whether to force the in-memory fake dsh adapter (local dev / no key). */
  useFakeDsh: boolean;
  /** dsh executable resolved from PATH. */
  dshBin: string;
  /** Provider route every dsh agent runs on. */
  dshProvider: string;
  /** Model id every dsh agent runs on. */
  dshModel: string;
  /** Base directory holding one per-user harness home. */
  dshHomeBase: string;
  /** Admin-configured DeepSeek key, injected into each child's env only. */
  deepseekApiKey?: string;
  /** Idle timeout before a user's dsh process is recycled (ms). */
  idleTimeoutMs: number;
  /** Upper bound on concurrently live dsh processes. */
  maxConcurrent: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: intEnv("PORT", 3001),
    dbPath: env.DSWEB_DB ?? resolve(process.cwd(), "dsweb.db"),
    useFakeDsh: env.DSH_ADAPTER === "fake" || (env.DEEPSEEK_API_KEY ?? "") === "",
    dshBin: env.DSH_BIN ?? "dsh",
    dshProvider: env.DSH_PROVIDER ?? "deepseek-official",
    dshModel: env.DSH_MODEL ?? "deepseek-flash",
    dshHomeBase: env.DSWEB_DSH_HOME ?? resolve(process.cwd(), ".dsh"),
    deepseekApiKey: env.DEEPSEEK_API_KEY,
    idleTimeoutMs: intEnv("DSH_IDLE_TIMEOUT_MS", 30 * 60 * 1000),
    maxConcurrent: intEnv("DSH_MAX_CONCURRENT", 64),
  };
}
