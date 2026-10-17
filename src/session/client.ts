import type { Dispatcher, WorkHandle, WorkInput } from "@oxian/oxian-js/work";
import type {
  PgNotification,
  PgSubscription,
  PgSubscriptionState,
} from "../client/types.ts";
import {
  decodeSessionFrames,
  encodeSessionFrame,
  writeEncodedSessionFrame,
} from "./codec.ts";
import {
  OMINIPG_SESSION_PROTOCOL,
  OMINIPG_SESSION_WORKLOAD,
  type OminipgSessionEvent,
  type OminipgSessionOperation,
  type OminipgSessionOutput,
  sessionRequest,
} from "./protocol.ts";

export type OminipgDispatcher = Dispatcher;

export type OminipgSessionTransport = Readonly<{
  dispatcher: OminipgDispatcher;
  workload?: string;
  target?: WorkInput["target"];
  metadata?: WorkInput["metadata"];
  deadlineAtMs?: number;
  signal?: AbortSignal;
  /** Maximum incoming session frame size; defaults to 512 MiB. */
  maxFrameBytes?: number;
}>;

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  transaction?: string;
  subscription?: string;
  snapshotId?: string;
  snapshotCurrent?: boolean;
};

type DrainScope =
  | Readonly<{ kind: "transaction"; id: string | undefined }>
  | Readonly<{ kind: "subscription"; id: string }>
  | Readonly<{ kind: "snapshot"; id: string; current?: boolean }>;

function matchesScope(request: PendingRequest, scope: DrainScope): boolean {
  if (scope.kind === "snapshot") {
    return request.snapshotId === scope.id &&
      (scope.current === undefined ||
        request.snapshotCurrent === scope.current);
  }
  return scope.kind === "subscription"
    ? request.subscription === scope.id
    : request.snapshotId === undefined && request.transaction === scope.id;
}

type SessionClientOptions = Readonly<{
  handle: WorkHandle;
  input: WritableStreamDefaultWriter<Uint8Array>;
  onError(error: Error): void;
  onClose(): void | Promise<void>;
  maxFrameBytes?: number;
  requestTimeoutMs?: number;
}>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function assertRequestTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("requestTimeoutMs must be a positive safe integer.");
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Empty/unlaned controls share the default pool lane; only real named lanes
 * are isolated. Non-query operations are also part of the default lane. */
function requestTransaction(
  operation: OminipgSessionOperation,
  payload: unknown,
): string | undefined {
  if (operation !== "query" || !payload || typeof payload !== "object") {
    return undefined;
  }
  const value = (payload as { transaction?: unknown }).transaction;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requestSnapshot(
  operation: OminipgSessionOperation,
  payload: unknown,
): { id: string; current: boolean } | undefined {
  if (
    (operation !== "snapshot-open" && operation !== "snapshot-query" &&
      operation !== "snapshot-close") ||
    !payload || typeof payload !== "object"
  ) return undefined;
  const value = payload as { snapshotId?: unknown; current?: unknown };
  return typeof value.snapshotId === "string" && value.snapshotId.length > 0
    ? {
      id: value.snapshotId,
      current: operation === "snapshot-query" && value.current === true,
    }
    : undefined;
}

function requestSubscription(
  operation: OminipgSessionOperation,
  payload: unknown,
): string | undefined {
  if (
    (operation !== "listen" && operation !== "unlisten") || !payload ||
    typeof payload !== "object"
  ) return undefined;
  const value = (payload as { subscriptionId?: unknown }).subscriptionId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Capture scalar routing fields once without normalizing unsupported classes.
 * Nested query values retain the existing codec behavior. */
function captureEnvelope(payload: unknown): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const prototype = Object.getPrototypeOf(payload);
    if (prototype === Object.prototype || prototype === null) {
      return { ...payload };
    }
  }
  return payload;
}

class RemoteSubscription implements PgSubscription {
  private _state: PgSubscriptionState = "connecting";
  private readonly stateHandlers = new Set<
    (state: PgSubscriptionState) => void
  >();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private resolveClosed!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    readonly id: string,
    readonly handler: (notification: PgNotification) => void,
    private readonly closeRemote: (id: string) => Promise<void>,
    private readonly reportError: (error: Error) => void,
  ) {}

  get state(): PgSubscriptionState {
    return this._state;
  }

  setState(state: PgSubscriptionState): void {
    if (state === this._state) return;
    this._state = state;
    for (const handler of this.stateHandlers) {
      try {
        handler(state);
      } catch {
        // Observers are isolated from the session lifecycle.
      }
    }
    if (state === "closed") this.resolveClosed();
  }

  emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch {
        // Observers are isolated from one another.
      }
    }
  }

  emitNotification(notification: PgNotification): void {
    try {
      this.handler(notification);
    } catch (error) {
      const normalized = toError(error);
      this.emitError(normalized);
      this.reportError(normalized);
    }
  }

  async close(): Promise<void> {
    if (this._state === "closed") return;
    await this.closeRemote(this.id);
    this.setState("closed");
  }

  onStateChange(handler: (state: PgSubscriptionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }
}

export class OminipgSessionClient {
  private requestId = 0;
  private subscriptionId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly subscriptions = new Map<string, RemoteSubscription>();
  private readonly handle: WorkHandle;
  private readonly input: WritableStreamDefaultWriter<Uint8Array>;
  private readonly onError: (error: Error) => void;
  private readonly onClose: () => void | Promise<void>;
  private readonly maxFrameBytes?: number;
  private readonly requestTimeoutMs: number;
  private readonly reading: Promise<void>;
  private writeTail: Promise<void> = Promise.resolve();
  /** Holds new requests while a timed-out request drains. */
  private requestGate: Promise<void> = Promise.resolve();
  /** Trusted initialize result; never inferred from caller URL or lane data. */
  private concurrent = false;
  private closing = false;
  private closed = false;

  constructor(options: SessionClientOptions) {
    this.handle = options.handle;
    this.input = options.input;
    this.onError = options.onError;
    this.onClose = options.onClose;
    this.maxFrameBytes = options.maxFrameBytes;
    this.requestTimeoutMs = options.requestTimeoutMs ??
      DEFAULT_REQUEST_TIMEOUT_MS;
    assertRequestTimeout(this.requestTimeoutMs);
    this.reading = this.readOutput();
    // A transport failure is reported through onError immediately. Keep the
    // original promise for close(), but mark both lifecycle rejections handled
    // even when an application never calls close after an unexpected failure.
    void this.reading.catch(() => {});
    void this.handle.completed.catch(() => {});
  }

  async request<T>(
    operation: OminipgSessionOperation,
    payload?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    assertRequestTimeout(timeoutMs);
    if (this.closed || this.closing && operation !== "close") {
      throw new Error("Ominipg session is closed.");
    }
    payload = captureEnvelope(payload);
    // Requests are sent without waiting for earlier responses; the workload
    // decides what may run concurrently.
    if (this.concurrent && operation !== "close") {
      const subscription = operation === "unlisten"
        ? requestSubscription(operation, payload)
        : undefined;
      const snapshot = requestSnapshot(operation, payload);
      const scope: DrainScope = snapshot
        ? {
          kind: "snapshot",
          id: snapshot.id,
          ...(operation === "snapshot-close"
            ? {}
            : { current: snapshot.current }),
        }
        : subscription === undefined
        ? { kind: "transaction", id: requestTransaction(operation, payload) }
        : { kind: "subscription", id: subscription };
      // Named progress and subscription cleanup must not wait on an unrelated
      // pool checkout. Unsubscribe completes without releasing the shared pin.
      // UNLISTEN waits for its own accepted subscription work (including a
      // pending LISTEN). Snapshot close drains both of its raw lanes; snapshot
      // reads/current authority never inherit unrelated default checkout waits.
      // New LISTEN and other unlaned work keep the default gate.
      while (
        [...this.pending.values()].some((request) =>
          matchesScope(request, scope) &&
          (scope.kind === "subscription" || operation === "snapshot-close" ||
            request.timedOut)
        )
      ) {
        await this.waitForIdle(scope);
      }
    } else {
      await this.requestGate;
    }
    if (this.closed || this.closing && operation !== "close") {
      throw new Error("Ominipg session is closed.");
    }
    const value = await this.sendRequest<T>(operation, payload, timeoutMs);
    if (operation === "initialize") {
      this.concurrent = Boolean(
        value && typeof value === "object" &&
          (value as { concurrent?: unknown }).concurrent === true,
      );
    }
    return value;
  }

  private async sendRequest<T>(
    operation: OminipgSessionOperation,
    payload: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const id = ++this.requestId;
    // Encoding failure never creates an accepted raw request or orphan timer.
    const encoded = encodeSessionFrame(sessionRequest(id, operation, payload));
    const snapshot = requestSnapshot(operation, payload);
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending || pending.timedOut) return;
        pending.timedOut = true;
        if (!this.concurrent) {
          this.requestGate = this.requestGate.then(() => this.whenIdle());
        }
        pending.reject(
          new Error(
            `Ominipg '${operation}' request timed out after ${timeoutMs}ms; ` +
              (this.concurrent
                ? "its lane will drain it before accepting more work."
                : "the session will drain it before accepting more work."),
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        timedOut: false,
        transaction: requestTransaction(operation, payload),
        subscription: requestSubscription(operation, payload),
        snapshotId: snapshot?.id,
        snapshotCurrent: snapshot?.current,
      });
    });
    const write = this.writeTail.then(() =>
      writeEncodedSessionFrame(this.input, encoded)
    );
    this.writeTail = write.catch(() => {});
    try {
      await write;
    } catch (error) {
      const pending = this.takePending(id);
      if (pending && !pending.timedOut) {
        pending.reject(error);
      }
    }
    return await response;
  }

  /** Resolves only after every accepted raw response drains. */
  whenIdle(): Promise<void> {
    return this.waitForIdle();
  }

  private waitForIdle(scope?: DrainScope): Promise<void> {
    const busy = () =>
      scope === undefined
        ? this.pending.size > 0
        : [...this.pending.values()].some((request) =>
          matchesScope(request, scope)
        );
    if (!busy()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (busy()) return;
        this.idleWaiters.delete(check);
        resolve();
      };
      this.idleWaiters.add(check);
    });
  }

  async listen(
    channel: string,
    handler: (notification: PgNotification) => void,
  ): Promise<PgSubscription> {
    const id = `subscription-${++this.subscriptionId}`;
    const subscription = new RemoteSubscription(
      id,
      handler,
      async (subscriptionId) => {
        this.subscriptions.delete(subscriptionId);
        if (!this.closed && !this.closing) {
          await this.request("unlisten", { subscriptionId });
        }
      },
      this.onError,
    );
    this.subscriptions.set(id, subscription);
    try {
      await this.request("listen", { subscriptionId: id, channel });
      subscription.setState("connected");
      return subscription;
    } catch (error) {
      this.subscriptions.delete(id);
      subscription.setState("closed");
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    let closeError: unknown;
    try {
      await this.request<void>("close", undefined, 30_000);
    } catch (error) {
      closeError = error;
    }
    try {
      await this.input.close();
    } catch {
      // The workload may have already closed its input after acknowledging close.
    }
    await this.reading.catch((error) => {
      closeError ??= error;
    });
    await this.handle.completed.catch((error) => {
      closeError ??= error;
    });
    await this.finish();
    if (closeError) throw closeError;
  }

  private async readOutput(): Promise<void> {
    try {
      for await (
        const raw of decodeSessionFrames(this.handle.output, {
          maxFrameBytes: this.maxFrameBytes,
        })
      ) {
        this.handleOutput(raw);
      }
      if (!this.closing) {
        throw new Error("Ominipg workload closed the session unexpectedly.");
      }
    } catch (error) {
      const normalized = toError(error);
      this.rejectPending(normalized);
      if (!this.closing) this.onError(normalized);
      throw normalized;
    } finally {
      if (!this.closing) await this.finish();
    }
  }

  private handleOutput(raw: unknown): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("Ominipg session output must be an object.");
    }
    const frame = raw as OminipgSessionOutput;
    if (frame.protocol !== OMINIPG_SESSION_PROTOCOL) {
      throw new TypeError("Unsupported Ominipg session protocol.");
    }
    if (frame.kind === "response") {
      const pending = this.takePending(frame.id);
      if (!pending) return;
      if (pending.timedOut) return;
      if (frame.ok) {
        pending.resolve(frame.value);
      } else {
        const error = new Error(frame.error.message);
        error.name = frame.error.name;
        if (frame.error.stack) error.stack = frame.error.stack;
        pending.reject(error);
      }
      return;
    }
    if (frame.kind !== "event") {
      throw new TypeError("Unknown Ominipg session output kind.");
    }
    this.handleEvent(frame);
  }

  private handleEvent(frame: OminipgSessionEvent): void {
    if (frame.event === "notification") {
      this.subscriptions.get(frame.subscriptionId)?.emitNotification(
        frame.notification,
      );
      return;
    }
    if (frame.event === "subscription-state") {
      this.subscriptions.get(frame.subscriptionId)?.setState(frame.state);
      return;
    }
    const error = new Error(frame.message);
    if (frame.subscriptionId) {
      this.subscriptions.get(frame.subscriptionId)?.emitError(error);
    }
    this.onError(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (!pending.timedOut) pending.reject(error);
    }
    this.pending.clear();
    this.resolveIdle();
  }

  private takePending(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.resolveIdle();
    return pending;
  }

  private resolveIdle(): void {
    for (const check of this.idleWaiters) check();
  }

  private async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.rejectPending(new Error("Ominipg session is closed."));
    for (const subscription of this.subscriptions.values()) {
      subscription.setState("closed");
    }
    this.subscriptions.clear();
    await this.input.abort(new Error("Ominipg session is closed.")).catch(
      () => {},
    );
    await this.onClose();
  }
}

export async function openOminipgSession(
  transport: OminipgSessionTransport,
  hooks: Readonly<{
    onError(error: Error): void;
    onClose(): void | Promise<void>;
    requestTimeoutMs?: number;
  }>,
): Promise<OminipgSessionClient> {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const writer = input.writable.getWriter();
  let handle: WorkHandle | undefined;
  try {
    handle = await transport.dispatcher.dispatch({
      workload: transport.workload ?? OMINIPG_SESSION_WORKLOAD,
      ...(transport.target ? { target: transport.target } : {}),
      ...(transport.metadata ? { metadata: transport.metadata } : {}),
      body: input.readable,
      ...(transport.deadlineAtMs === undefined
        ? {}
        : { deadlineAtMs: transport.deadlineAtMs }),
      ...(transport.signal ? { signal: transport.signal } : {}),
    });
    await handle.started;
    const metadata = await handle.metadata;
    if (metadata.protocol !== OMINIPG_SESSION_PROTOCOL) {
      throw new Error("Worker did not accept the Ominipg session protocol.");
    }
  } catch (error) {
    await writer.abort(error).catch(() => {});
    if (handle) {
      await handle.cancel("ominipg_session_open_failed").catch(() => {});
      await handle.completed.catch(() => {});
    }
    throw error;
  }
  if (!handle) throw new Error("Ominipg dispatcher returned no work handle.");
  return new OminipgSessionClient({
    handle,
    input: writer,
    onError: hooks.onError,
    onClose: hooks.onClose,
    maxFrameBytes: transport.maxFrameBytes,
    requestTimeoutMs: hooks.requestTimeoutMs,
  });
}
