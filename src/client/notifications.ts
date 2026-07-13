import type {
  PgNotificationMessage,
  PgPool,
  PgPoolClient,
} from "../shared/types.ts";
import type {
  PgNotification,
  PgSubscription,
  PgSubscriptionState,
} from "./types.ts";

type NotificationHandler = (notification: PgNotification) => void;
type StateHandler = (state: PgSubscriptionState) => void;
type ErrorHandler = (error: Error) => void;

const CHANNEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function validateNotificationChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new Error(
      "PostgreSQL notification channels must match /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.",
    );
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class Subscription implements PgSubscription {
  private _state: PgSubscriptionState = "connecting";
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    readonly channel: string,
    readonly handler: NotificationHandler,
    private readonly closeSubscription: (
      subscription: Subscription,
    ) => Promise<void>,
  ) {}

  get state(): PgSubscriptionState {
    return this._state;
  }

  setState(state: PgSubscriptionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const handler of this.stateHandlers) {
      try {
        handler(state);
      } catch {
        // Subscription observers must not affect connection management.
      }
    }
    if (state === "closed") this.resolveClosed();
  }

  emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch {
        // Error observers are isolated from one another.
      }
    }
  }

  async close(): Promise<void> {
    await this.closeSubscription(this);
  }

  onStateChange(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }
}

export class PgListenerHub {
  private readonly subscriptions = new Map<string, Set<Subscription>>();
  private readonly listenedChannels = new Set<string>();
  private client?: PgPoolClient;
  private connecting?: Promise<void>;
  private reconnectTimer?: number;
  private reconnectAttempt = 0;
  private closing = false;

  constructor(
    private readonly pool: PgPool,
    private readonly reportError: (error: Error) => void,
  ) {}

  async listen(
    channel: string,
    handler: NotificationHandler,
  ): Promise<PgSubscription> {
    validateNotificationChannel(channel);
    if (this.closing) {
      throw new Error("Ominipg notification listener is closed.");
    }
    if ((this.pool.options?.max ?? 5) < 2) {
      throw new Error(
        "Ominipg listen() requires pgPoolMax >= 2 because the listener pins one connection.",
      );
    }

    const subscription = new Subscription(
      channel,
      handler,
      (entry) => this.remove(entry),
    );
    const entries = this.subscriptions.get(channel) ?? new Set<Subscription>();
    entries.add(subscription);
    this.subscriptions.set(channel, entries);

    try {
      await this.ensureConnected();
      await this.ensureListening(channel);
      subscription.setState("connected");
      return subscription;
    } catch (error) {
      await this.remove(subscription);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.connecting) {
      try {
        await this.connecting;
      } catch {
        // A failed in-flight connect needs no further shutdown work.
      }
    }

    const client = this.client;
    this.client = undefined;
    this.detachClient(client);
    if (client) {
      try {
        await client.query("UNLISTEN *");
      } catch {
        // The connection may already be gone during shutdown.
      }
      client.release();
    }

    this.listenedChannels.clear();
    for (const entries of this.subscriptions.values()) {
      for (const subscription of entries) subscription.setState("closed");
    }
    this.subscriptions.clear();
  }

  private async remove(subscription: Subscription): Promise<void> {
    if (subscription.state === "closed") return;
    const entries = this.subscriptions.get(subscription.channel);
    entries?.delete(subscription);
    subscription.setState("closed");
    if (entries?.size) return;

    this.subscriptions.delete(subscription.channel);
    if (this.client && this.listenedChannels.has(subscription.channel)) {
      try {
        await this.client.query(
          `UNLISTEN ${quoteIdentifier(subscription.channel)}`,
        );
      } catch (error) {
        this.handleDisconnect(this.client, toError(error));
      }
    }
    this.listenedChannels.delete(subscription.channel);
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return await this.connecting;
    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<void> {
    let client: PgPoolClient | undefined;
    let assigned = false;
    try {
      client = await this.pool.connect();
      if (this.closing) {
        client.release();
        return;
      }
      client.on("notification", this.onNotification);
      client.on("error", this.onClientError);
      client.on("end", this.onClientEnd);
      this.client = client;
      assigned = true;
      this.listenedChannels.clear();
      for (const channel of this.subscriptions.keys()) {
        await this.ensureListening(channel);
      }
      this.reconnectAttempt = 0;
      this.setState("connected");
    } catch (error) {
      if (client) {
        this.detachClient(client);
        if (!assigned || this.client === client) {
          if (this.client === client) this.client = undefined;
          client.release(true);
        }
      }
      throw toError(error);
    }
  }

  private async ensureListening(channel: string): Promise<void> {
    if (this.listenedChannels.has(channel)) return;
    const client = this.client;
    if (!client) {
      throw new Error("PostgreSQL listener connection is unavailable.");
    }
    await client.query(`LISTEN ${quoteIdentifier(channel)}`);
    this.listenedChannels.add(channel);
  }

  private readonly onNotification = (message: PgNotificationMessage): void => {
    const entries = this.subscriptions.get(message.channel);
    if (!entries) return;
    const notification: PgNotification = {
      channel: message.channel,
      payload: message.payload,
      processId: message.processId,
    };
    for (const subscription of entries) {
      try {
        subscription.handler(notification);
      } catch (error) {
        const normalized = toError(error);
        subscription.emitError(normalized);
        this.safeReportError(normalized);
      }
    }
  };

  private readonly onClientError = (error: Error): void => {
    if (this.client) this.handleDisconnect(this.client, error);
  };

  private readonly onClientEnd = (): void => {
    if (this.client) {
      this.handleDisconnect(
        this.client,
        new Error("PostgreSQL listener connection ended."),
      );
    }
  };

  private handleDisconnect(client: PgPoolClient, error: Error): void {
    if (this.client !== client || this.closing) return;
    this.client = undefined;
    this.listenedChannels.clear();
    this.detachClient(client);
    client.release(true);
    this.safeReportError(error);
    for (const entries of this.subscriptions.values()) {
      for (const subscription of entries) subscription.emitError(error);
    }
    this.setState("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (
      this.closing || this.reconnectTimer !== undefined ||
      !this.subscriptions.size
    ) {
      return;
    }
    const delay = Math.min(5_000, 100 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = Number(setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (this.closing || !this.subscriptions.size) return;
      try {
        await this.ensureConnected();
      } catch (error) {
        const normalized = toError(error);
        this.safeReportError(normalized);
        for (const entries of this.subscriptions.values()) {
          for (const subscription of entries) {
            subscription.emitError(normalized);
          }
        }
        this.scheduleReconnect();
      }
    }, delay));
  }

  private setState(state: PgSubscriptionState): void {
    for (const entries of this.subscriptions.values()) {
      for (const subscription of entries) subscription.setState(state);
    }
  }

  private safeReportError(error: Error): void {
    try {
      this.reportError(error);
    } catch {
      // Client error observers must not break notification delivery/recovery.
    }
  }

  private detachClient(client?: PgPoolClient): void {
    if (!client) return;
    client.removeListener("notification", this.onNotification);
    client.removeListener("error", this.onClientError);
    client.removeListener("end", this.onClientEnd);
  }
}
