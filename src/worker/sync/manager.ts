import type { OminipgEngineConfig } from "../../shared/types.ts";
import { type EngineState, requireMainDb } from "../db.ts";
import { ensureRemoteSchema } from "../schema.ts";
import { startPuller, stopPuller } from "./puller.ts";
import { pushBatch } from "./pusher.ts";
import { performInitialSync } from "./initial.ts";

/**
 * Starts all synchronization services.
 * @param cfg The initialization configuration.
 */
export async function startSyncServices(
  state: EngineState,
  cfg: OminipgEngineConfig,
) {
  if (!state.syncPool) return;

  // Ensure remote schema exists before starting sync
  await ensureRemoteSchema(state, cfg.schemaSQL ?? []);

  // Perform initial data sync from remote to local
  if (!cfg.skipInitialSync) {
    await performInitialSync(state, cfg.initialSyncFrom);
  }

  // Start the replication puller
  await startPuller(state, cfg);

  // If using PGlite, set up a listener to automatically push changes
  if (state.mainDbType === "pglite" && !cfg.disableAutoPush) {
    requireMainDb(state).listen?.("outbox_new", () => {
      pushBatch(state).catch((err) => console.error("Auto-push failed:", err));
    });
  }
}

/**
 * Stops all synchronization services.
 */
export async function stopSyncServices(state: EngineState) {
  if (!state.syncPool) return;

  await stopPuller(state);
}
