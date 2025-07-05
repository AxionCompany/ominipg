
import type { InitMsg } from '../shared/types.ts';
import { initConnections, closeConnections, mainDb, mainDbType, syncPool } from './db.ts';
import { bootstrapSchema } from './schema.ts';
import { startSyncServices, stopSyncServices } from './sync/manager.ts';

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
    console.log("Booting database worker...");
    
    EDGE_ID = cfg.edgeId || crypto.randomUUID();
    LWW_COL = cfg.lwwColumn || "updated_at";

    // 1. Initialize database connections (main and optional sync)
    await initConnections(cfg);

    // 2. Set up the database schema
    // The 'includeSyncInfrastructure' flag is true if we are syncing.
    await bootstrapSchema(cfg.schemaSQL ?? [], !!syncPool);

    // 3. Start synchronization services if configured
    if (syncPool) {
        await startSyncServices(cfg);
    } else {
        console.log("No sync URL provided. Running in standalone mode.");
    }

    console.log("Database worker booted successfully.");
}

/**
 * Gracefully shuts down all services and connections.
 */
export async function shutdown() {
    console.log("Shutting down database worker...");
    await stopSyncServices();
    await closeConnections();
    console.log("Shutdown complete.");
} 