import type { PgProvider } from "../shared/types.ts";

export function createPgProvider(): PgProvider {
  return {
    moduleSpecifier: "npm:pg@^8.16.3",
    logicalReplicationModuleSpecifier: "npm:pg-logical-replication@^2.4.0",
    loadPg: () => import("npm:pg@^8.16.3"),
    loadLogicalReplication: () => import("npm:pg-logical-replication@^2.4.0"),
  };
}

export type { PgProvider } from "../shared/types.ts";
