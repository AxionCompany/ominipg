import type { OminipgTransactionOptions } from "../shared/transaction.ts";
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
    begin?: OminipgTransactionOptions,
  ): Promise<unknown[]> {
    this.assertReady();
    return await exec(this.state, sql, params, transaction, begin);
  }

  async sync(): Promise<number> {
    this.assertReady();
    if (this.state.mainDbType === "postgres" && !this.state.syncPool) {
      throw new Error("Sync is disabled in direct Postgres mode");
    }
    return await pushBatch(this.state);
  }

  async syncSequences(): Promise<number> {
    this.assertReady();
    if (this.state.mainDbType === "postgres" && !this.state.syncPool) {
      throw new Error("Sync sequences is disabled in direct Postgres mode");
    }
    return await synchronizeSequences(this.state);
  }

  async dumpDataDir(): Promise<Blob> {
    this.assertReady();
    return await dumpDataDir(this.state);
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    this.assertReady();
    return await getDiagnosticInfo(this.state) as Record<
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

  close(): Promise<void> {
    this.closed = true;
    return this.closePromise ??= Promise.resolve().then(() =>
      this.closeResources()
    );
  }

  private assertReady(): void {
    if (this.closed) throw new Error("Ominipg engine is closed.");
    if (!this.initialized) {
      throw new Error("Ominipg engine is not initialized.");
    }
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
