import type {
  WorkerHostDispatchInput,
  WorkerHostWorkHandle,
} from "@oxian/oxian-js/host";
import type {
  PgNotification,
  PgSubscription,
  PgSubscriptionState,
} from "../client/types.ts";
import { decodeSessionFrames, encodeSessionFrame } from "./codec.ts";
import {
  OMINIPG_SESSION_PROTOCOL,
  OMINIPG_SESSION_WORKLOAD,
  type OminipgSessionEvent,
  type OminipgSessionOperation,
  type OminipgSessionOutput,
  sessionRequest,
} from "./protocol.ts";

export type OminipgDispatcher = Readonly<{
  dispatch(input: WorkerHostDispatchInput): Promise<WorkerHostWorkHandle>;
}>;

export type OminipgSessionTransport = Readonly<{
  dispatcher: OminipgDispatcher;
  workload?: string;
  target?: WorkerHostDispatchInput["target"];
  metadata?: WorkerHostDispatchInput["metadata"];
  deadlineAtMs?: number;
  signal?: AbortSignal;
  /** Maximum incoming session frame size; defaults to 512 MiB. */
  maxFrameBytes?: number;
}>;

type PendingRequest = {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

type SessionClientOptions = Readonly<{
  handle: WorkerHostWorkHandle;
  input: WritableStreamDefaultWriter<Uint8Array>;
  onError(error: Error): void;
  onClose(): void | Promise<void>;
  maxFrameBytes?: number;
}>;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
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
  private readonly subscriptions = new Map<string, RemoteSubscription>();
  private readonly handle: WorkerHostWorkHandle;
  private readonly input: WritableStreamDefaultWriter<Uint8Array>;
  private readonly onError: (error: Error) => void;
  private readonly onClose: () => void | Promise<void>;
  private readonly maxFrameBytes?: number;
  private readonly reading: Promise<void>;
  private closing = false;
  private closed = false;

  constructor(options: SessionClientOptions) {
    this.handle = options.handle;
    this.input = options.input;
    this.onError = options.onError;
    this.onClose = options.onClose;
    this.maxFrameBytes = options.maxFrameBytes;
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
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed || this.closing && operation !== "close") {
      throw new Error("Ominipg session is closed.");
    }
    const id = ++this.requestId;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Ominipg '${operation}' request timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    try {
      await this.input.write(
        encodeSessionFrame(sessionRequest(id, operation, payload)),
      );
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      }
    }
    return await response;
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
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
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
      pending.reject(error);
    }
    this.pending.clear();
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
  }>,
): Promise<OminipgSessionClient> {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const writer = input.writable.getWriter();
  let handle: WorkerHostWorkHandle | undefined;
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
  });
}
