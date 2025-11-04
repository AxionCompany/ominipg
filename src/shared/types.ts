import type { PGliteOptions } from "npm:@electric-sql/pglite@0.3.4";

export type WorkerMsg =
  | InitMsg
  | ExecMsg
  | SyncMsg
  | SyncSeqMsg
  | DiagnosticMsg
  | CloseMsg;

export interface PGliteConfig extends PGliteOptions {
  /**
   * Allow downstream consumers to pass through additional vendor-specific options.
   */
  [key: string]: unknown;
}

export type { Extensions as PGliteExtensionsMap } from "npm:@electric-sql/pglite@0.3.4";

export type ResponseMsg =
  | { type: "init-ok"; reqId: number }
  | { type: "exec-ok"; reqId: number; rows: unknown[] }
  | { type: "sync-ok"; reqId: number; pushed: number }
  | { type: "sync-sequences-ok"; reqId: number; synced: number }
  | {
    type: "diagnostic-ok";
    reqId: number;
    info: Record<string, unknown>;
  }
  | { type: "error"; reqId?: number; error: string };

/*───────────────── Message Types ──────────────────*/

export interface InitMsg {
  type: "init";
  reqId: number;
  url: string;
  syncUrl?: string;
  schemaSQL?: string[];
  edgeId?: string;
  lwwColumn?: string;
  skipInitialSync?: boolean;
  initialSyncFrom?: string;
  disableAutoPush?: boolean;
  pgliteExtensions?: string[];
  pgliteConfig?: PGliteConfig;
  logMetrics?: boolean;
}

export type ExecMsg = {
  type: "exec";
  reqId: number;
  sql: string;
  params?: unknown[];
};

export type SyncMsg = {
  type: "sync";
  reqId: number;
};

export type SyncSeqMsg = {
  type: "sync-sequences";
  reqId: number;
};

export type DiagnosticMsg = {
  type: "diagnostic";
  reqId: number;
};

export type CloseMsg = {
  type: "close";
};
