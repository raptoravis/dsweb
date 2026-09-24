import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { createApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { Db } from "./db.js";
import { FakeAdapterFactory, FakeDshStore } from "./dsh/fake.js";
import { ProcessManager } from "./dsh/process-manager.js";
import { RealAdapterFactory } from "./dsh/real.js";
import type { DshService } from "./dsh/types.js";

/** Wire the dsh service from config: fake for tests/dev, real otherwise. */
export function buildDsh(config: Config): DshService {
  const options = {
    idleTimeoutMs: config.idleTimeoutMs,
    maxConcurrent: config.maxConcurrent,
    homeBase: config.dshHomeBase,
  };
  const factory = config.useFakeDsh
    ? new FakeAdapterFactory(new FakeDshStore())
    : new RealAdapterFactory({
        command: [config.dshBin, "--profile", "sdk"],
        provider: config.dshProvider,
        model: config.dshModel,
        apiKey: config.deepseekApiKey,
      });
  return new ProcessManager(factory, options);
}

function main(): void {
  const envFile = resolve(process.cwd(), ".env");
  if (existsSync(envFile)) loadEnvFile(envFile);
  const config = loadConfig();
  const db = new Db(config.dbPath);
  const dsh = buildDsh(config);
  const app = createApp(db, dsh);

  const server = app.listen(config.port, () => {
    const mode = config.useFakeDsh ? "fake" : "real";
    console.log(`dsweb backend listening on :${config.port} (dsh=${mode})`);
  });

  const shutdown = (): void => {
    server.close(() => {
      void dsh.closeAll().finally(() => {
        db.close();
        process.exit(0);
      });
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
