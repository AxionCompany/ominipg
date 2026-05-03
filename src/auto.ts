/**
 * @module
 *
 * Utilities for automatically selecting optional database providers from
 * Ominipg connection URLs.
 */

import type { OminipgConnectionOptions } from "./client/types.ts";
import { createPgProvider } from "./providers/pg.ts";
import { createPGliteProvider } from "./providers/pglite.ts";
import type { PGliteProvider, PgProvider } from "./shared/types.ts";

export interface AutoProviders {
  pgliteProvider?: PGliteProvider;
  pgProvider?: PgProvider;
}

export type AutoConfiguredOptions<T extends OminipgConnectionOptions> =
  & T
  & AutoProviders;

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
 * This helper does not import PGlite, node-postgres, or logical replication
 * modules eagerly. It only creates provider descriptors that Ominipg can load
 * later if the selected mode needs them.
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
      (needsPGlite ? createPGliteProvider() : undefined),
    pgProvider: options.pgProvider ??
      (needsPg ? createPgProvider() : undefined),
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
