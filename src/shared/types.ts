/**
 * @module
 *
 * Shared message and configuration types used by the Ominipg worker pipeline.
 * These definitions describe the structured payloads exchanged between the
 * main thread and the worker responsible for executing database operations.
 */

/**
 * Union describing every message that can be sent from the main thread to the
 * worker. Each variant represents a discrete command or control signal.
 */
export type WorkerMsg =
  | InitMsg
  | ExecMsg
  | SyncMsg
  | SyncSeqMsg
  | DiagnosticMsg
  | CloseMsg;

/**
 * Extended configuration passed to the embedded PGlite engine.
 *
 * This interface inherits all standard PGlite options and allows additional
 * vendor-specific keys for fine-grained tuning.
 */
export interface PGliteConfig extends PGliteOptions {
  /**
   * Allow downstream consumers to pass through additional vendor-specific options.
   */
  [key: string]: unknown;
}

export interface PGliteOptions {
  extensions?: PGliteExtensionsMap;
  [key: string]: unknown;
}

export type PGliteExtensionsMap = Record<string, unknown>;

export interface PGliteInstance {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
  listen(channel: string, callback: () => void): Promise<unknown>;
  close(): Promise<void>;
}

export interface PGliteConstructor {
  new (...args: any[]): PGliteInstance;
}

export interface PGliteModule {
  PGlite: PGliteConstructor;
}

export interface PGliteProvider {
  moduleSpecifier?: string;
  extensionSpecifiers?: Record<string, string>;
  loadPGlite?: () => Promise<PGliteModule>;
  loadExtension?: (name: string) => Promise<Record<string, unknown>>;
}

export interface PgPoolClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

export interface PgPool {
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
  options?: { connectionString?: string };
}

export interface PgModule {
  Pool: new (options: { connectionString: string; max?: number }) => PgPool;
}

export interface LogicalReplicationServiceLike {
  on(event: string, listener: (...args: any[]) => void): void;
  subscribe(plugin: unknown, slotName: string): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface PgLogicalReplicationModule {
  LogicalReplicationService: new (
    options: { connectionString: string },
  ) => LogicalReplicationServiceLike;
  PgoutputPlugin: new (options: {
    protoVersion: 1 | 2;
    publicationNames: string[];
  }) => unknown;
}

export interface PgProvider {
  moduleSpecifier?: string;
  logicalReplicationModuleSpecifier?: string;
  loadPg?: () => Promise<PgModule>;
  loadLogicalReplication?: () => Promise<PgLogicalReplicationModule>;
}

/**
 * Responses emitted by the worker back to the main thread.
 *
 * Each message corresponds to the completion (or failure) of a previously
 * issued worker request.
 */
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

/**
 * Initialization payload sent to the worker when it starts.
 */
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
  pgliteProvider?: PGliteProvider;
  pgProvider?: PgProvider;
  logMetrics?: boolean;
}

/**
 * Executes a SQL statement inside the worker context.
 */
export type ExecMsg = {
  type: "exec";
  reqId: number;
  sql: string;
  params?: unknown[];
};

/**
 * Triggers a sync cycle that pushes tracked mutations to the remote database.
 */
export type SyncMsg = {
  type: "sync";
  reqId: number;
};

/**
 * Instructs the worker to resynchronize sequence values.
 */
export type SyncSeqMsg = {
  type: "sync-sequences";
  reqId: number;
};

/**
 * Requests diagnostic information from the worker.
 */
export type DiagnosticMsg = {
  type: "diagnostic";
  reqId: number;
};

/**
 * Signals the worker to perform cleanup and shut down.
 */
export type CloseMsg = {
  type: "close";
};
