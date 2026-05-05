import type { PGliteConfig, PGliteProvider } from "../shared/types.ts";
export {
  createLowMemoryPGliteConfig,
  type LowMemoryPGliteConfigOptions,
  lowMemoryPGliteStartParams,
} from "../shared/pglite_config.ts";

const extensionSpecifiers: Record<string, string> = {
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

export function createPGliteProvider(): PGliteProvider {
  return {
    moduleSpecifier: "@electric-sql/pglite",
    extensionSpecifiers,
    loadPGlite: () => import("@electric-sql/pglite"),
    loadExtension: (name: string) => {
      const specifier = extensionSpecifiers[name];
      if (!specifier) {
        throw new Error(`Unsupported PGlite extension: ${name}`);
      }
      return import(specifier);
    },
  };
}

export type { PGliteConfig, PGliteProvider } from "../shared/types.ts";
