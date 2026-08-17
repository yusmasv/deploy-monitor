import { getConfig } from "./config";
import { openDb, type Db } from "./db";
import { getExecutor } from "./executor";
import { Runner } from "./runner";

let singleton: { db: Db; runner: Runner } | undefined;

export function getServer() {
  const cfg = getConfig();
  if (!singleton) {
    const db = openDb(cfg.dbPath);
    // Deploy yang sedang berjalan saat proses mati tidak akan pernah selesai.
    const orphans = db.markRunningAsInterrupted();
    if (orphans > 0) console.warn(`[monitor] ${orphans} deploy yatim ditandai interrupted.`);

    singleton = {
      db,
      runner: new Runner({
        db,
        executor: getExecutor(cfg),
        deploySh: cfg.deploySh,
        uploadsDir: cfg.uploadsDir,
        publicHost: cfg.publicHost,
        limits: { maxTotalBytes: cfg.maxZipBytes, maxEntries: 20000 },
      }),
    };
  }
  return { ...singleton, cfg };
}
