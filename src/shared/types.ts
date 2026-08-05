/**
 * @module
 *
 * Database provider and engine configuration contracts shared by the Ominipg
 * client, session protocol, and workload engine.
 */

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
  dumpDataDir?(): Promise<Blob>;
  close(): Promise<void>;
}

export interface PGliteConstructor {
  new (dataDir?: string, options?: PGliteOptions): PGliteInstance;
  new (options?: PGliteOptions): PGliteInstance;
}

export interface PGliteModule {
  PGlite: unknown;
}

export interface PGliteProvider {
  moduleSpecifier?: string;
  extensionSpecifiers?: Record<string, string>;
  loadPGlite?: () => Promise<PGliteModule>;
  loadExtension?: (name: string) => Promise<Record<string, unknown>>;
}

export interface PgPoolClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(destroy?: boolean): void;
  on(
    event: "notification",
    listener: (message: PgNotificationMessage) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "end", listener: () => void): this;
  removeListener(
    event: "notification",
    listener: (message: PgNotificationMessage) => void,
  ): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "end", listener: () => void): this;
}

export interface PgNotificationMessage {
  processId: number;
  channel: string;
  payload?: string;
}

export interface PgPool {
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
  options?: { connectionString?: string; max?: number };
}

export interface PgModule {
  Pool: new (options: { connectionString: string; max?: number }) => PgPool;
}

export interface LogicalReplicationServiceLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
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
 * Serializable database initialization configuration applied by one workload
 * session.
 */
export interface OminipgEngineConfig {
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
  /**
   * Built-in memory tuning profile for PGlite.
   *
   * Defaults to "low-memory". Set to "default" to use upstream PGlite defaults.
   * A custom `pgliteConfig.startParams` also disables the built-in profile.
   */
  pgliteMemoryProfile?: "default" | "low-memory";
  pgliteProvider?: PGliteProvider;
  pgProvider?: PgProvider;
  pgPoolMax?: number;
  logMetrics?: boolean;
}
