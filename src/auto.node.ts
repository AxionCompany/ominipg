/**
 * @module
 *
 * Node.js auto-provider descriptors for the npm package.
 */

import type { OminipgConnectionOptions } from "./client/types.ts";
import type { PGliteProvider, PgProvider } from "./shared/types.ts";

export interface AutoProviders {
  pgliteProvider?: PGliteProvider;
  pgProvider?: PgProvider;
}

export type AutoConfiguredOptions<T extends OminipgConnectionOptions> =
  & T
  & AutoProviders;

const pgliteExtensionSpecifiers: Record<string, string> = {
  vector: "@electric-sql/pglite/vector",
  live: "@electric-sql/pglite/live",
  uuid_ossp: "@electric-sql/pglite/contrib/uuid_ossp",
  amcheck: "@electric-sql/pglite/contrib/amcheck",
  auto_explain: "@electric-sql/pglite/contrib/auto_explain",
  bloom: "@electric-sql/pglite/contrib/bloom",
  btree_gin: "@electric-sql/pglite/contrib/btree_gin",
  btree_gist: "@electric-sql/pglite/contrib/btree_gist",
  citext: "@electric-sql/pglite/contrib/citext",
  cube: "@electric-sql/pglite/contrib/cube",
  earthdistance: "@electric-sql/pglite/contrib/earthdistance",
  fuzzystrmatch: "@electric-sql/pglite/contrib/fuzzystrmatch",
  hstore: "@electric-sql/pglite/contrib/hstore",
  isn: "@electric-sql/pglite/contrib/isn",
  lo: "@electric-sql/pglite/contrib/lo",
  ltree: "@electric-sql/pglite/contrib/ltree",
  pg_trgm: "@electric-sql/pglite/contrib/pg_trgm",
  seg: "@electric-sql/pglite/contrib/seg",
  tablefunc: "@electric-sql/pglite/contrib/tablefunc",
  tcn: "@electric-sql/pglite/contrib/tcn",
  tsm_system_rows: "@electric-sql/pglite/contrib/tsm_system_rows",
  tsm_system_time: "@electric-sql/pglite/contrib/tsm_system_time",
};

function createAutoPGliteProvider(): PGliteProvider {
  return {
    moduleSpecifier: "@electric-sql/pglite",
    extensionSpecifiers: pgliteExtensionSpecifiers,
  };
}

function createAutoPgProvider(): PgProvider {
  return {
    moduleSpecifier: "pg",
    logicalReplicationModuleSpecifier: "pg-logical-replication",
  };
}

function isPostgresUrl(url: string): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

function isPGliteUrl(url: string): boolean {
  return url === "" || url === ":memory:" || url.startsWith("file://");
}

function assertSupportedUrl(url: string, field: "url" | "syncUrl") {
  if (isPostgresUrl(url) || isPGliteUrl(url)) return;
  throw new Error(
    `Unsupported ${field} format: ${url}. Use ':memory:' or 'file://' for PGlite, or 'postgres://'/'postgresql://' for PostgreSQL.`,
  );
}

function validateAutoProviderUrls(url: string, syncUrl?: string) {
  assertSupportedUrl(url, "url");
  if (!syncUrl) return;

  assertSupportedUrl(syncUrl, "syncUrl");
  if (!isPostgresUrl(syncUrl)) {
    throw new Error(
      "syncUrl must be a PostgreSQL connection string (postgres:// or postgresql://).",
    );
  }
  if (!isPGliteUrl(url)) {
    throw new Error(
      "Ominipg sync currently requires a local PGlite url with a PostgreSQL syncUrl.",
    );
  }
}

export function resolveAutoProviders(
  options: Pick<
    OminipgConnectionOptions,
    "url" | "syncUrl" | "pgliteProvider" | "pgProvider"
  >,
): AutoProviders {
  const url = options.url ?? ":memory:";
  validateAutoProviderUrls(url, options.syncUrl);

  const needsPGlite = isPGliteUrl(url);
  const needsPg = isPostgresUrl(url) || !!options.syncUrl;

  return {
    pgliteProvider: options.pgliteProvider ??
      (needsPGlite ? createAutoPGliteProvider() : undefined),
    pgProvider: options.pgProvider ??
      (needsPg ? createAutoPgProvider() : undefined),
  };
}

export function autoConfigure<T extends OminipgConnectionOptions>(
  options: T,
): AutoConfiguredOptions<T> {
  return {
    ...options,
    ...resolveAutoProviders(options),
  };
}
