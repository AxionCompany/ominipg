import type { OminipgEngineConfig } from "../shared/types.ts";
import type {
  PgNotification,
  PgSubscription,
  PgSubscriptionState,
} from "../client/types.ts";
import {
  PgListenerHub,
  validateNotificationChannel,
} from "../client/notifications.ts";
import { boot, shutdown } from "./bootstrap.ts";
import {
  createEngineState,
  dumpDataDir,
  type EngineDependencies,
  type EngineState,
  exec,
} from "./db.ts";
import { getDiagnosticInfo } from "./diagnostics.ts";
import { synchronizeSequences } from "./sync/sequences.ts";
import { pushBatch } from "./sync/pusher.ts";
import { AccountedPgPool, PgPairCleanupError } from "./pool-capacity.ts";
import { openExclusiveReadSnapshot } from "./exclusive-snapshot.ts";

type SnapshotResource = Readonly<{
  query(
    sql: string,
    params: unknown[] | undefined,
    current: boolean,
  ): Promise<unknown[]>;
  close(): Promise<void>;
}>;
type EngineSnapshot = {
  id: string;
  kind: "exclusive" | "pooled";
  controller: AbortController;
  opening: Promise<SnapshotResource>;
  closing?: Promise<void>;
};

export type OminipgEngineDependencies = EngineDependencies;

/** A single stateful database engine owned by one Oxian workload session. */
export class OminipgEngine {
  readonly state: EngineState;
  private readonly reportError: (error: Error) => void;
  private readonly subscriptions = new Map<string, PgSubscription>();
  private listenerHub?: PgListenerHub;
  private initialized = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private quarantineFailure?: { error: unknown };
  private readonly ordinary = new Set<Promise<unknown>>();
  private snapshot?: EngineSnapshot;
  private snapshotAdmissionClosed = false;

  constructor(dependencies: OminipgEngineDependencies = {}) {
    // A native client fault may also reach its notification subscription.
    // Report that same error once while keeping subscription recovery intact.
    const reported = new WeakSet<Error>();
    this.reportError = (error) => {
      if (reported.has(error)) return;
      reported.add(error);
      try {
        void Promise.resolve(dependencies.onError?.(error)).catch(() => {});
      } catch {
        // Diagnostics must not change SQL outcomes or cleanup.
      }
    };
    this.state = createEngineState({
      ...dependencies,
      onError: this.reportError,
    });
  }

  async initialize(config: OminipgEngineConfig): Promise<void> {
    if (this.initialized) {
      throw new Error("Ominipg engine is already initialized.");
    }
    if (this.closed) throw new Error("Ominipg engine is closed.");
    try {
      await boot(this.state, config);
      this.initialized = true;
    } catch (error) {
      await shutdown(this.state).catch(() => {});
      throw error;
    }
  }

  /**
   * Whether queries may run concurrently. PostgreSQL uses a pool; PGlite is
   * one connection, so its client keeps submitting one operation at a time.
   */
  get concurrent(): boolean {
    return this.initialized && this.state.mainDbType === "postgres";
  }

  /**
   * Runs one statement. A `transaction` lane pins every statement from its
   * BEGIN through COMMIT or ROLLBACK to one connection.
   */
  async query(
    sql: string,
    params?: unknown[],
    transaction?: string,
  ): Promise<unknown[]> {
    this.assertReady();
    return await this.track(() => exec(this.state, sql, params, transaction));
  }

  async sync(): Promise<number> {
    this.assertReady();
    if (this.state.mainDbType === "postgres" && !this.state.syncPool) {
      throw new Error("Sync is disabled in direct Postgres mode");
    }
    return await this.track(() => pushBatch(this.state));
  }

  async syncSequences(): Promise<number> {
    this.assertReady();
    if (this.state.mainDbType === "postgres" && !this.state.syncPool) {
      throw new Error("Sync sequences is disabled in direct Postgres mode");
    }
    return await this.track(() => synchronizeSequences(this.state));
  }

  async dumpDataDir(): Promise<Blob> {
    this.assertReady();
    return await this.track(() => dumpDataDir(this.state));
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    this.assertReady();
    return await this.track(() => getDiagnosticInfo(this.state)) as Record<
      string,
      unknown
    >;
  }

  async notify(channel: string, payload = ""): Promise<void> {
    this.assertReady();
    if (this.state.mainDbType !== "postgres") {
      throw new Error("Ominipg notify() requires a PostgreSQL connection.");
    }
    validateNotificationChannel(channel);
    await this.query("SELECT pg_notify($1, $2)", [channel, payload]);
  }

  async listen(
    subscriptionId: string,
    channel: string,
    observer: Readonly<{
      onNotification: (notification: PgNotification) => void;
      onState?: (state: PgSubscriptionState) => void;
      onError?: (error: Error) => void;
    }>,
  ): Promise<void> {
    this.assertReady();
    if (this.state.mainDbType !== "postgres" || !this.state.mainPool) {
      throw new Error("Ominipg listen() requires a PostgreSQL connection.");
    }
    if (this.subscriptions.has(subscriptionId)) {
      throw new Error(`Duplicate Ominipg subscription id: ${subscriptionId}`);
    }
    this.listenerHub ??= new PgListenerHub(
      this.state.mainPool,
      this.reportError,
    );
    const subscription = await this.listenerHub.listen(
      channel,
      observer.onNotification,
    );
    if (observer.onState) subscription.onStateChange(observer.onState);
    if (observer.onError) subscription.onError(observer.onError);
    this.subscriptions.set(subscriptionId, subscription);
  }

  async unlisten(subscriptionId: string): Promise<void> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    this.subscriptions.delete(subscriptionId);
    await subscription.close();
  }

  /** Internal trusted-SQL resource boundary; session/owner adapters own callers. */
  async openReadSnapshot(id: string): Promise<"exclusive" | "pooled"> {
    this.assertReady(false);
    if (this.snapshotAdmissionClosed) {
      throw new Error("Snapshot admission is closed.");
    }
    if (!id || id.length > 256) throw new TypeError("Invalid snapshot id.");
    if (this.snapshot) throw new Error("A read snapshot is already active.");
    const kind = this.concurrent ? "pooled" : "exclusive";
    if (
      kind === "exclusive" && (this.state.syncPool || this.state.syncStarted)
    ) {
      throw new Error("Exclusive snapshots do not support background sync.");
    }
    const controller = new AbortController();
    const preceding = [...this.ordinary];
    const opening = Promise.resolve().then(
      async (): Promise<SnapshotResource> => {
        if (kind === "exclusive") {
          // Claim is installed synchronously below. All accepted ordinary work
          // drains before the actual SQL-idle predicate, with no new admission.
          await Promise.allSettled(preceding);
          controller.signal.throwIfAborted();
          const db = this.state.mainDb;
          if (!db?.exclusiveSnapshotProvider) {
            throw new Error("Exclusive snapshot provider is unavailable.");
          }
          const provider = await db.exclusiveSnapshotProvider();
          controller.signal.throwIfAborted();
          const reader = await openExclusiveReadSnapshot(
            provider,
            (error) => this.quarantine(error),
            controller.signal,
          );
          return {
            async query(sql, params, current) {
              if (current) {
                throw new Error(
                  "Exclusive snapshots have no independent current lane.",
                );
              }
              return (await reader.query(sql, params)).rows;
            },
            close: reader.close,
          };
        }
        const pool = this.state.mainPool;
        if (!(pool instanceof AccountedPgPool)) {
          throw new Error("Accounted snapshot pool is unavailable.");
        }
        const pair = await pool.reservePair(controller.signal).catch(
          async (error) => {
            if (error instanceof PgPairCleanupError) {
              return await this.failSnapshot(error);
            }
            throw error;
          },
        );
        try {
          controller.signal.throwIfAborted();
          await pair.clients[0].query(
            "BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ",
          );
          controller.signal.throwIfAborted();
          return {
            async query(sql, params, current) {
              return (await pair.clients[current ? 1 : 0].query(sql, params))
                .rows;
            },
            close: pair.release,
          };
        } catch (error) {
          try {
            await pair.release();
          } catch (cleanupError) {
            return await this.failSnapshot(
              new AggregateError(
                [error, cleanupError],
                "Snapshot open and cleanup failed.",
              ),
            );
          }
          throw error;
        }
      },
    );
    const record: EngineSnapshot = { id, kind, controller, opening };
    this.snapshot = record;
    try {
      await opening;
      controller.signal.throwIfAborted();
      return kind;
    } catch (error) {
      // Opening owns cleanup before rejection. Unknown physical cleanup
      // quarantines the engine, so this cannot make its capacity reusable.
      if (this.snapshot === record) this.snapshot = undefined;
      if (this.quarantineFailure) this.quarantineFailure.error = error;
      throw error;
    }
  }

  async queryReadSnapshot(
    id: string,
    sql: string,
    params?: unknown[],
    current = false,
  ): Promise<unknown[]> {
    this.assertReady(false);
    const record = this.snapshot;
    if (!record || record.id !== id || record.closing) {
      throw new Error("Read snapshot is not active.");
    }
    const resource = await record.opening;
    record.controller.signal.throwIfAborted();
    const rows = await resource.query(sql, params, current);
    record.controller.signal.throwIfAborted();
    return rows;
  }

  closeReadSnapshot(id: string): Promise<void> {
    const record = this.snapshot;
    if (!record) {
      return this.quarantineFailure
        ? Promise.reject(this.quarantineFailure.error)
        : Promise.resolve();
    }
    if (record.id !== id) {
      return Promise.reject(new Error("Read snapshot id does not match."));
    }
    if (record.closing) return record.closing;
    record.controller.abort(new Error("Read snapshot is closed."));
    record.closing = Promise.resolve().then(async () => {
      let resource: SnapshotResource;
      try {
        resource = await record.opening;
      } catch {
        // Opening already owns and awaits cleanup. Physical cleanup errors
        // remain observable even if physical quarantine shutdown succeeds.
        if (this.quarantineFailure) throw this.quarantineFailure.error;
        return;
      }
      try {
        await resource.close();
      } catch (error) {
        await this.failSnapshot(error);
      } finally {
        if (this.snapshot === record) this.snapshot = undefined;
      }
    });
    return record.closing;
  }

  /** Graceful transport teardown releases snapshot pins before waiting for
   * ordinary work that needs them. Accepted ordinary lanes remain admissible
   * until the caller drains them and invokes full close(). */
  prepareShutdown(): Promise<void> {
    this.snapshotAdmissionClosed = true;
    const record = this.snapshot;
    return this.closeReadSnapshot(record?.id ?? "");
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const raw = Promise.resolve().then(operation);
    this.ordinary.add(raw);
    void raw.then(
      () => this.ordinary.delete(raw),
      () => this.ordinary.delete(raw),
    );
    return raw;
  }

  private async failSnapshot(error: unknown): Promise<never> {
    try {
      await this.quarantine(error);
    } catch (cleanupError) {
      const combined = new AggregateError(
        [error, cleanupError],
        "Snapshot failure and database shutdown both failed.",
      );
      this.quarantineFailure = { error: combined };
      throw combined;
    }
    throw error;
  }

  private quarantine(error: unknown): Promise<void> {
    this.quarantineFailure ??= { error };
    this.closed = true;
    // Native cleanup has already settled; bypass the snapshot's own close
    // promise so fail-close cannot wait on itself.
    return this.shutdownResources();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const closeSnapshot = this.prepareShutdown();
    this.closePromise = Promise.resolve().then(async () => {
      let failed = false;
      let failure: unknown;
      try {
        await closeSnapshot;
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        await this.shutdownResources();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
      if (this.quarantineFailure) throw this.quarantineFailure.error;
      if (failed) throw failure;
    });
    return this.closePromise;
  }

  private assertReady(ordinary = true): void {
    if (this.closed) throw new Error("Ominipg engine is closed.");
    if (ordinary && this.snapshot?.kind === "exclusive") {
      throw new Error(
        "Ordinary operations are unavailable during an exclusive snapshot.",
      );
    }
    if (!this.initialized) {
      throw new Error("Ominipg engine is not initialized.");
    }
  }

  private shutdownResources(): Promise<void> {
    return this.shutdownPromise ??= Promise.resolve().then(() =>
      this.closeResources()
    );
  }

  private async closeResources(): Promise<void> {
    let firstError: unknown;
    const attempt = async (cleanup: () => Promise<unknown>) => {
      try {
        await cleanup();
      } catch (error) {
        firstError ??= error;
      }
    };

    for (const subscription of this.subscriptions.values()) {
      await attempt(() => subscription.close());
    }
    this.subscriptions.clear();
    const listenerHub = this.listenerHub;
    this.listenerHub = undefined;
    if (listenerHub) await attempt(() => listenerHub.close());
    await attempt(() => shutdown(this.state));
    this.initialized = false;
    if (firstError) throw firstError;
  }
}
