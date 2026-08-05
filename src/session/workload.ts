import type { WorkerWorkHandler } from "@oxian/oxian-js/worker";
import type { OminipgEngineDependencies } from "../worker/engine.ts";
import { OminipgEngine } from "../worker/engine.ts";
import { decodeSessionFrames, encodeSessionFrame } from "./codec.ts";
import {
  assertSessionRequest,
  OMINIPG_SESSION_PROTOCOL,
  type OminipgSessionEvent,
  type OminipgSessionInitConfig,
  type OminipgSessionRequest,
  type OminipgSessionResponse,
} from "./protocol.ts";

export type OminipgWorkloadOptions = Readonly<{
  dependencies?: OminipgEngineDependencies;
  resolveDependencies?: (
    metadata: Readonly<Record<string, unknown>>,
  ) => OminipgEngineDependencies | Promise<OminipgEngineDependencies>;
  maxFrameBytes?: number;
}>;

class FrameSink {
  private tail = Promise.resolve();
  private closed = false;

  constructor(
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {}

  write(frame: OminipgSessionResponse | OminipgSessionEvent): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("Session output is closed."));
    }
    const write = this.tail.then(() =>
      this.writer.write(encodeSessionFrame(frame))
    );
    this.tail = write.catch(() => {});
    return write;
  }

  writeBestEffort(frame: OminipgSessionEvent): void {
    void this.write(frame).catch(() => {
      // Late database events are expected while a session is shutting down.
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    await this.writer.close();
  }

  async abort(reason: unknown): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writer.abort(reason).catch(() => {});
  }
}

function toErrorPayload(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function recordPayload(
  request: OminipgSessionRequest,
): Record<string, unknown> {
  if (
    !request.payload || typeof request.payload !== "object" ||
    Array.isArray(request.payload)
  ) {
    throw new TypeError(
      `Ominipg ${request.operation} payload must be an object.`,
    );
  }
  return request.payload as Record<string, unknown>;
}

async function executeRequest(
  engine: OminipgEngine,
  sink: FrameSink,
  request: OminipgSessionRequest,
): Promise<unknown> {
  switch (request.operation) {
    case "initialize": {
      const config = recordPayload(request) as OminipgSessionInitConfig;
      if (typeof config.url !== "string") {
        throw new TypeError("Ominipg initialize requires a string url.");
      }
      await engine.initialize(config);
      return undefined;
    }
    case "query": {
      const payload = recordPayload(request);
      if (typeof payload.sql !== "string") {
        throw new TypeError("Ominipg query requires a string sql value.");
      }
      if (payload.params !== undefined && !Array.isArray(payload.params)) {
        throw new TypeError("Ominipg query params must be an array.");
      }
      return {
        rows: await engine.query(payload.sql, payload.params as unknown[]),
      };
    }
    case "sync":
      return { pushed: await engine.sync() };
    case "sync-sequences":
      return { synced: await engine.syncSequences() };
    case "dump-data-dir": {
      const dataDir = await engine.dumpDataDir();
      return {
        dataDirBytes: new Uint8Array(await dataDir.arrayBuffer()),
        dataDirType: dataDir.type || undefined,
      };
    }
    case "diagnostics":
      return { info: await engine.diagnostics() };
    case "listen": {
      const payload = recordPayload(request);
      if (
        typeof payload.subscriptionId !== "string" ||
        typeof payload.channel !== "string"
      ) {
        throw new TypeError(
          "Ominipg listen requires subscriptionId and channel strings.",
        );
      }
      const subscriptionId = payload.subscriptionId;
      await engine.listen(subscriptionId, payload.channel, {
        onNotification: (notification) => {
          sink.writeBestEffort({
            protocol: OMINIPG_SESSION_PROTOCOL,
            kind: "event",
            event: "notification",
            subscriptionId,
            notification,
          });
        },
        onState: (state) => {
          sink.writeBestEffort({
            protocol: OMINIPG_SESSION_PROTOCOL,
            kind: "event",
            event: "subscription-state",
            subscriptionId,
            state,
          });
        },
        onError: (error) => {
          sink.writeBestEffort({
            protocol: OMINIPG_SESSION_PROTOCOL,
            kind: "event",
            event: "error",
            subscriptionId,
            message: error.message,
          });
        },
      });
      return undefined;
    }
    case "unlisten": {
      const payload = recordPayload(request);
      if (typeof payload.subscriptionId !== "string") {
        throw new TypeError(
          "Ominipg unlisten requires a subscriptionId string.",
        );
      }
      await engine.unlisten(payload.subscriptionId);
      return undefined;
    }
    case "notify": {
      const payload = recordPayload(request);
      if (typeof payload.channel !== "string") {
        throw new TypeError("Ominipg notify requires a channel string.");
      }
      if (
        payload.payload !== undefined && typeof payload.payload !== "string"
      ) {
        throw new TypeError("Ominipg notification payload must be a string.");
      }
      await engine.notify(
        payload.channel,
        payload.payload as string | undefined,
      );
      return undefined;
    }
    case "close":
      await engine.close();
      return undefined;
  }
}

/**
 * Creates the long-lived `ominipg.session.v1` Oxian workload.
 *
 * Every dispatch owns one engine instance and multiplexes commands, responses,
 * and notifications over the operation's bidirectional byte streams.
 */
export function createOminipgWorkload(
  options: OminipgWorkloadOptions = {},
): WorkerWorkHandler {
  return async ({ input, metadata, signal, sendMetadata }) => {
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const sink = new FrameSink(output.writable.getWriter());
    const resolved = options.resolveDependencies
      ? await options.resolveDependencies(metadata)
      : {};
    const configured = options.dependencies ?? {};
    const configuredOnError = configured.onError;
    const resolvedOnError = resolved.onError;
    const engine = new OminipgEngine({
      ...configured,
      ...resolved,
      onError(error) {
        try {
          configuredOnError?.(error);
        } catch {
          // Host observers cannot interrupt the workload session.
        }
        try {
          resolvedOnError?.(error);
        } catch {
          // Host observers cannot interrupt the workload session.
        }
        sink.writeBestEffort({
          protocol: OMINIPG_SESSION_PROTOCOL,
          kind: "event",
          event: "error",
          message: error.message,
        });
      },
    });

    signal.addEventListener("abort", () => {
      void engine.close().catch(() => {}).then(() => sink.abort(signal.reason));
    }, { once: true });

    void (async () => {
      try {
        for await (
          const raw of decodeSessionFrames(input, {
            maxFrameBytes: options.maxFrameBytes,
          })
        ) {
          const request = assertSessionRequest(raw);
          try {
            const value = await executeRequest(engine, sink, request);
            await sink.write({
              protocol: OMINIPG_SESSION_PROTOCOL,
              kind: "response",
              id: request.id,
              ok: true,
              ...(value === undefined ? {} : { value }),
            });
          } catch (error) {
            await sink.write({
              protocol: OMINIPG_SESSION_PROTOCOL,
              kind: "response",
              id: request.id,
              ok: false,
              error: toErrorPayload(error),
            });
          }
          if (request.operation === "close") break;
        }
        await engine.close();
        await sink.close();
      } catch (error) {
        await engine.close().catch(() => {});
        await sink.abort(error);
      }
    })();

    await sendMetadata({ protocol: OMINIPG_SESSION_PROTOCOL });
    return { body: output.readable };
  };
}
