import type { OminipgEngineConfig } from "../shared/types.ts";
import type { PgNotification, PgSubscriptionState } from "../client/types.ts";

export const OMINIPG_SESSION_PROTOCOL = "ominipg.session.v1" as const;
export const OMINIPG_SESSION_WORKLOAD = "ominipg.session.v1" as const;

export type OminipgProviderDescriptor = Readonly<{
  moduleSpecifier?: string;
  extensionSpecifiers?: Readonly<Record<string, string>>;
  logicalReplicationModuleSpecifier?: string;
}>;

export type OminipgSessionInitConfig =
  & Omit<
    OminipgEngineConfig,
    "pgliteProvider" | "pgProvider"
  >
  & Readonly<{
    pgliteProvider?: OminipgProviderDescriptor;
    pgProvider?: OminipgProviderDescriptor;
  }>;

export type OminipgSessionOperation =
  | "initialize"
  | "query"
  | "sync"
  | "sync-sequences"
  | "dump-data-dir"
  | "diagnostics"
  | "listen"
  | "unlisten"
  | "notify"
  | "close";

export type OminipgSessionRequest = Readonly<{
  protocol: typeof OMINIPG_SESSION_PROTOCOL;
  kind: "request";
  id: number;
  operation: OminipgSessionOperation;
  payload?: unknown;
}>;

export type OminipgSessionResponse =
  & Readonly<{
    protocol: typeof OMINIPG_SESSION_PROTOCOL;
    kind: "response";
    id: number;
  }>
  & (
    | Readonly<{ ok: true; value?: unknown }>
    | Readonly<{
      ok: false;
      error: Readonly<{
        name: string;
        message: string;
        stack?: string;
      }>;
    }>
  );

export type OminipgSessionEvent =
  | Readonly<{
    protocol: typeof OMINIPG_SESSION_PROTOCOL;
    kind: "event";
    event: "notification";
    subscriptionId: string;
    notification: PgNotification;
  }>
  | Readonly<{
    protocol: typeof OMINIPG_SESSION_PROTOCOL;
    kind: "event";
    event: "subscription-state";
    subscriptionId: string;
    state: PgSubscriptionState;
  }>
  | Readonly<{
    protocol: typeof OMINIPG_SESSION_PROTOCOL;
    kind: "event";
    event: "error";
    message: string;
    subscriptionId?: string;
  }>;

export type OminipgSessionOutput =
  | OminipgSessionResponse
  | OminipgSessionEvent;

export function sessionRequest(
  id: number,
  operation: OminipgSessionOperation,
  payload?: unknown,
): OminipgSessionRequest {
  return {
    protocol: OMINIPG_SESSION_PROTOCOL,
    kind: "request",
    id,
    operation,
    ...(payload === undefined ? {} : { payload }),
  };
}

export function assertSessionRequest(value: unknown): OminipgSessionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Ominipg session frame must be an object.");
  }
  const frame = value as Record<string, unknown>;
  if (frame.protocol !== OMINIPG_SESSION_PROTOCOL) {
    throw new TypeError("Unsupported Ominipg session protocol.");
  }
  if (frame.kind !== "request") {
    throw new TypeError("Ominipg session input must be a request frame.");
  }
  if (!Number.isSafeInteger(frame.id) || (frame.id as number) < 1) {
    throw new TypeError(
      "Ominipg session request id must be a positive integer.",
    );
  }
  const operations: readonly string[] = [
    "initialize",
    "query",
    "sync",
    "sync-sequences",
    "dump-data-dir",
    "diagnostics",
    "listen",
    "unlisten",
    "notify",
    "close",
  ];
  if (!operations.includes(String(frame.operation))) {
    throw new TypeError(
      `Unknown Ominipg operation: ${String(frame.operation)}`,
    );
  }
  return frame as OminipgSessionRequest;
}
