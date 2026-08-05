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

export type OminipgEngineDependencies =
  & EngineDependencies
  & Readonly<{
    onError?: (error: Error) => void;
  }>;

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
    this.state = createEngineState(dependencies);
    this.reportError = dependencies.onError ?? (() => {});
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

  async query(sql: string, params?: unknown[]): Promise<unknown[]> {
    this.assertReady();
    return await exec(this.state, sql, params);
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
    return await getDiagnosticInfo(this.state) as Record<string, unknown>;
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
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeResources();
    return this.closePromise;
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
