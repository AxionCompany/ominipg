import { assertEquals, assertThrows } from "jsr:@std/assert";
import { autoConfigure, resolveAutoProviders } from "../src/auto.ts";
import type { PGliteProvider, PgProvider } from "../src/shared/types.ts";

Deno.test("autoConfigure injects PGlite provider for default local URL", () => {
  const configured = autoConfigure({});

  assertEquals(
    configured.pgliteProvider?.moduleSpecifier?.includes("pglite"),
    true,
  );
  assertEquals(configured.pgProvider, undefined);
});

Deno.test("autoConfigure injects pg provider for direct PostgreSQL URL", () => {
  const configured = autoConfigure({
    url: "postgresql://user:pass@localhost:5432/app",
  });

  assertEquals(configured.pgliteProvider, undefined);
  assertEquals(configured.pgProvider?.moduleSpecifier?.includes("pg"), true);
  assertEquals(
    configured.pgProvider?.logicalReplicationModuleSpecifier?.includes(
      "pg-logical-replication",
    ),
    true,
  );
});

Deno.test("autoConfigure injects both providers for local-first sync", () => {
  const configured = autoConfigure({
    url: ":memory:",
    syncUrl: "postgres://user:pass@localhost:5432/app",
  });

  assertEquals(
    configured.pgliteProvider?.moduleSpecifier?.includes("pglite"),
    true,
  );
  assertEquals(configured.pgProvider?.moduleSpecifier?.includes("pg"), true);
});

Deno.test("autoConfigure preserves custom providers", () => {
  const pgliteProvider: PGliteProvider = {
    moduleSpecifier: "custom:pglite",
  };
  const pgProvider: PgProvider = {
    moduleSpecifier: "custom:pg",
    logicalReplicationModuleSpecifier: "custom:replication",
  };

  const configured = autoConfigure({
    url: ":memory:",
    syncUrl: "postgresql://user:pass@localhost:5432/app",
    pgliteProvider,
    pgProvider,
  });

  assertEquals(configured.pgliteProvider, pgliteProvider);
  assertEquals(configured.pgProvider, pgProvider);
});

Deno.test("resolveAutoProviders rejects unsupported sync shapes", () => {
  assertThrows(
    () =>
      resolveAutoProviders({
        url: "postgresql://user:pass@localhost:5432/local",
        syncUrl: "postgresql://user:pass@localhost:5432/remote",
      }),
    Error,
    "sync currently requires a local PGlite url",
  );
});
