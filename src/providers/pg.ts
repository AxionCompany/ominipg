import type { PgProvider } from "../shared/types.ts";

export function createPgProvider(): PgProvider {
  return {
    moduleSpecifier: "pg",
    logicalReplicationModuleSpecifier: "pg-logical-replication",
    loadPg: () => import("pg"),
    loadLogicalReplication: () => import("pg-logical-replication"),
  };
}

export type { PgProvider } from "../shared/types.ts";
