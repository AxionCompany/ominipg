import type { PGliteConfig, PGliteProvider } from "../shared/types.ts";
export {
  createLowMemoryPGliteConfig,
  type LowMemoryPGliteConfigOptions,
  lowMemoryPGliteStartParams,
} from "../shared/pglite_config.ts";

const extensionSpecifiers: Record<string, string> = {
  vector: "npm:@electric-sql/pglite@^0.4.5/vector",
  live: "npm:@electric-sql/pglite@^0.4.5/live",
  uuid_ossp: "npm:@electric-sql/pglite@^0.4.5/contrib/uuid_ossp",
  amcheck: "npm:@electric-sql/pglite@^0.4.5/contrib/amcheck",
  auto_explain: "npm:@electric-sql/pglite@^0.4.5/contrib/auto_explain",
  bloom: "npm:@electric-sql/pglite@^0.4.5/contrib/bloom",
  btree_gin: "npm:@electric-sql/pglite@^0.4.5/contrib/btree_gin",
  btree_gist: "npm:@electric-sql/pglite@^0.4.5/contrib/btree_gist",
  citext: "npm:@electric-sql/pglite@^0.4.5/contrib/citext",
  cube: "npm:@electric-sql/pglite@^0.4.5/contrib/cube",
  earthdistance: "npm:@electric-sql/pglite@^0.4.5/contrib/earthdistance",
  fuzzystrmatch: "npm:@electric-sql/pglite@^0.4.5/contrib/fuzzystrmatch",
  hstore: "npm:@electric-sql/pglite@^0.4.5/contrib/hstore",
  isn: "npm:@electric-sql/pglite@^0.4.5/contrib/isn",
  lo: "npm:@electric-sql/pglite@^0.4.5/contrib/lo",
  ltree: "npm:@electric-sql/pglite@^0.4.5/contrib/ltree",
  pg_trgm: "npm:@electric-sql/pglite@^0.4.5/contrib/pg_trgm",
  seg: "npm:@electric-sql/pglite@^0.4.5/contrib/seg",
  tablefunc: "npm:@electric-sql/pglite@^0.4.5/contrib/tablefunc",
  tcn: "npm:@electric-sql/pglite@^0.4.5/contrib/tcn",
  tsm_system_rows: "npm:@electric-sql/pglite@^0.4.5/contrib/tsm_system_rows",
  tsm_system_time: "npm:@electric-sql/pglite@^0.4.5/contrib/tsm_system_time",
};

export function createPGliteProvider(): PGliteProvider {
  return {
    moduleSpecifier: "npm:@electric-sql/pglite@^0.4.5",
    extensionSpecifiers,
    loadPGlite: () => import("npm:@electric-sql/pglite@^0.4.5"),
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
