
import type { InitMsg } from "../../shared/types.ts";
import { mainDb, mainDbType, syncPool } from "../db.ts";
import { ensureRemoteSchema } from "../schema.ts";
import { startPuller, stopPuller } from "./puller.ts";
import { pushBatch } from "./pusher.ts";
import { performInitialSync } from './initial.ts';

/**
 * Starts all synchronization services.
 * @param cfg The initialization configuration.
 */
export async function startSyncServices(cfg: InitMsg) {
    if (!syncPool) return;

    // Ensure remote schema exists before starting sync
    await ensureRemoteSchema(cfg.schemaSQL ?? []);

    // Perform initial data sync from remote to local
    if (!cfg.skipInitialSync) {
        await performInitialSync(cfg.initialSyncFrom);
    }

    // Start the replication puller
    await startPuller(cfg);

    // If using PGlite, set up a listener to automatically push changes
    if (mainDbType === 'pglite' && !cfg.disableAutoPush) {
        mainDb.listen?.("outbox_new", () => {
            pushBatch().catch(err => console.error("Auto-push failed:", err));
        });
    }
}

/**
 * Stops all synchronization services.
 */
export async function stopSyncServices() {
    if (!syncPool) return;

    await stopPuller();
} 