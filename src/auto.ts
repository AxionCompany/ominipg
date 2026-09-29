/**
 * @module
 *
 * Utilities for automatically selecting optional database providers from
 * Ominipg connection URLs.
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

const PGLITE_EXTENSION_PATHS: Record<string, string> = {
  vector: "vector",
  live: "live",
  uuid_ossp: "contrib/uuid_ossp",
  amcheck: "contrib/amcheck",
  auto_explain: "contrib/auto_explain",
  bloom: "contrib/bloom",
  btree_gin: "contrib/btree_gin",
  btree_gist: "contrib/btree_gist",
  citext: "contrib/citext",
  cube: "contrib/cube",
  earthdistance: "contrib/earthdistance",
  fuzzystrmatch: "contrib/fuzzystrmatch",
  hstore: "contrib/hstore",
  isn: "contrib/isn",
  lo: "contrib/lo",
  ltree: "contrib/ltree",
  pg_trgm: "contrib/pg_trgm",
  seg: "contrib/seg",
  tablefunc: "contrib/tablefunc",
  tcn: "contrib/tcn",
  tsm_system_rows: "contrib/tsm_system_rows",
  tsm_system_time: "contrib/tsm_system_time",
};

/**
 * Deno resolves versioned `npm:` specifiers itself. Node and Bun load this
 * JSR package from `node_modules`, where only bare package names resolve.
 */
function npmSpecifier(name: string, version: string, subpath?: string): string {
  const path = subpath ? `/${subpath}` : "";
  return "Deno" in globalThis
    ? `npm:${name}@${version}${path}`
    : `${name}${path}`;
}

function createAutoPGliteProvider(): PGliteProvider {
  const pglite = (subpath?: string) =>
    npmSpecifier("@electric-sql/pglite", "^0.4.5", subpath);
  return {
    moduleSpecifier: pglite(),
    extensionSpecifiers: Object.fromEntries(
      Object.entries(PGLITE_EXTENSION_PATHS).map((
        [name, subpath],
      ) => [name, pglite(subpath)]),
    ),
  };
}

function createAutoPgProvider(): PgProvider {
  return {
    moduleSpecifier: npmSpecifier("pg", "^8.16.3"),
    logicalReplicationModuleSpecifier: npmSpecifier(
      "pg-logical-replication",
      "^2.4.0",
    ),
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

/**
 * Resolves the optional providers required by a pair of Ominipg URLs.
 *
 * This helper intentionally does not import the PGlite or pg provider factory
 * modules, because those modules contain literal dynamic imports that Deno
 * compile must include. The returned descriptors are string-only, so engine
 * modules are loaded only by the runtime path that actually needs them.
 */
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

/**
 * Decorates regular Ominipg connection options with the provider factories
 * required by `url` and `syncUrl`.
 *
 * Existing custom providers are preserved. Missing `url` follows
 * `Ominipg.connect()` and is treated as `:memory:`.
 */
export function autoConfigure<T extends OminipgConnectionOptions>(
  options: T,
): AutoConfiguredOptions<T> {
  return {
    ...options,
    ...resolveAutoProviders(options),
  };
}
