
import type { InitMsg } from '../shared/types.ts';
import { initConnections, closeConnections, syncPool } from './db.ts';
import { bootstrapSchema } from './schema.ts';
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
    await initConnections(cfg);

    // 2. Set up the database schema
    // The 'includeSyncInfrastructure' flag is true if we are syncing.
    await bootstrapSchema(cfg.schemaSQL ?? [], !!syncPool);

    // 3. Start synchronization services if configured
    if (syncPool) {
        if (!startSyncServices) {
            const mod = await import('./sync/manager.ts');
            startSyncServices = mod.startSyncServices;
            stopSyncServices = mod.stopSyncServices;
        }
        await startSyncServices(cfg);
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