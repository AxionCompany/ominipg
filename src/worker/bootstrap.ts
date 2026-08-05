import type { OminipgEngineConfig } from "../shared/types.ts";
import { closeConnections, type EngineState, initConnections } from "./db.ts";
import { bootstrapSchema } from "./schema.ts";

/*───────────────── Public API ──────────────────*/

/**
 * Initializes the entire database worker based on the provided configuration.
 * This is the main entry point for starting the service.
 * @param cfg The initialization configuration.
 */
export async function boot(state: EngineState, cfg: OminipgEngineConfig) {
  state.edgeId = cfg.edgeId || crypto.randomUUID();
  state.lwwColumn = cfg.lwwColumn || "updated_at";

  // 1. Initialize database connections (main and optional sync)
  const before = state.getRssMb();
  await initConnections(state, cfg);
  const after = state.getRssMb();
  if (cfg.logMetrics && before != null && after != null) {
    console.log(
      `Worker boot complete initConnections (+${
        after - before
      } MB, rss=${after} MB)`,
    );
  }
  // 2. Set up the database schema
  // The 'includeSyncInfrastructure' flag is true if we are syncing.
  const beforeSchema = state.getRssMb();
  await bootstrapSchema(state, cfg.schemaSQL ?? [], !!state.syncPool);
  const afterSchema = state.getRssMb();
  if (cfg.logMetrics && beforeSchema != null && afterSchema != null) {
    console.log(
      `Worker boot complete bootstrapSchema (+${
        afterSchema - beforeSchema
      } MB, rss=${afterSchema} MB)`,
    );
  }
  // 3. Start synchronization services if configured
  const beforeSync = state.getRssMb();
  if (state.syncPool) {
    const { startSyncServices } = await import("./sync/manager.ts");
    state.syncStarted = true;
    await startSyncServices(state, cfg);
  }
  const afterSync = state.getRssMb();
  if (cfg.logMetrics && beforeSync != null && afterSync != null) {
    console.log(
      `Worker boot complete startSyncServices (+${
        afterSync - beforeSync
      } MB, rss=${afterSync} MB)`,
    );
  }
}

/**
 * Gracefully shuts down all services and connections.
 */
export async function shutdown(state: EngineState) {
  let firstError: unknown;
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
  if (state.syncStarted) {
    try {
      const { stopSyncServices } = await import("./sync/manager.ts");
      await stopSyncServices(state);
    } catch (error) {
      firstError = error;
    }
    state.syncStarted = false;
  }
  try {
    await closeConnections(state);
  } catch (error) {
    firstError ??= error;
  }
  if (firstError) throw firstError;
}
