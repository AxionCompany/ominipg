import type { InitMsg } from "../shared/types.ts";
import { closeConnections, initConnections, syncPool } from "./db.ts";
import { bootstrapSchema } from "./schema.ts";
import { getRssMb } from "./utils.ts";
// Lazily import sync services only when sync is configured
let startSyncServices: ((cfg: InitMsg) => Promise<void>) | undefined;
let stopSyncServices: (() => Promise<void>) | undefined;

/*───────────────── State ──────────────────*/

export let EDGE_ID: string = crypto.randomUUID();
export let LWW_COL: string = "updated_at";

/*───────────────── Public API ──────────────────*/

/**
 * Initializes the entire database worker based on the provided configuration.
 * This is the main entry point for starting the service.
 * @param cfg The initialization configuration.
 */
export async function boot(cfg: InitMsg) {
  EDGE_ID = cfg.edgeId || crypto.randomUUID();
  LWW_COL = cfg.lwwColumn || "updated_at";

  // 1. Initialize database connections (main and optional sync)
  const before = getRssMb();
  await initConnections(cfg);
  const after = getRssMb();
  if (cfg.logMetrics && before != null && after != null) {
    console.log(
      `Worker boot complete initConnections (+${after - before} MB, rss=${after} MB)`,
    );
  }
  // 2. Set up the database schema
  // The 'includeSyncInfrastructure' flag is true if we are syncing.
  const beforeSchema = getRssMb();
  await bootstrapSchema(cfg.schemaSQL ?? [], !!syncPool);
  const afterSchema = getRssMb();
  if (cfg.logMetrics && beforeSchema != null && afterSchema != null) {
    console.log(
      `Worker boot complete bootstrapSchema (+${afterSchema - beforeSchema} MB, rss=${afterSchema} MB)`,
    );
  }
  // 3. Start synchronization services if configured
  const beforeSync = getRssMb();
  if (syncPool) {
    if (!startSyncServices) {
      const mod = await import("./sync/manager.ts");
      startSyncServices = mod.startSyncServices;
      stopSyncServices = mod.stopSyncServices;
    }
    await startSyncServices(cfg);
  }
  const afterSync = getRssMb();
  if (cfg.logMetrics && beforeSync != null && afterSync != null) {
    console.log(
      `Worker boot complete startSyncServices (+${afterSync - beforeSync} MB, rss=${afterSync} MB)`,
    );
  }
}

/**
 * Gracefully shuts down all services and connections.
 */
export async function shutdown() {
  if (stopSyncServices) {
    await stopSyncServices();
  }
  await closeConnections();
}
