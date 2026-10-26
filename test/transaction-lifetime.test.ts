import { EventEmitter } from "node:events";
import { assertEquals, assertRejects } from "@std/assert";
import { Ominipg, type OminipgTransaction } from "../src/client/index.ts";
import type { PgModule, PgPoolClient } from "../src/shared/types.ts";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(concurrent: boolean, timeout = 1000) {
  const operations: string[] = [];
  let hook: ((sql: string) => Promise<void>) | undefined;
  let closes = 0;
  let clientId = 0;
  const query = async (sql: string, id = 0) => {
    operations.push(`${id}:${sql}`);
    await hook?.(sql);
    return { rows: [] };
  };
  class Pool {
    connect() {
      const id = ++clientId;
      return Promise.resolve(
        Object.assign(new EventEmitter(), {
          query: (sql: string) => query(sql, id),
          release() {},
        }) as unknown as PgPoolClient,
      );
    }
    end() {
      closes++;
      return Promise.resolve();
    }
  }
  class PGlite {
    query(sql: string) {
      return query(sql);
    }
    exec() {
      return Promise.resolve();
    }
    listen() {
      return Promise.resolve();
    }
    close() {
      closes++;
      return Promise.resolve();
    }
  }
  const db = await Ominipg.connect({
    url: concurrent ? "postgres://test/test" : ":memory:",
    requestTimeoutMs: timeout,
    ...(concurrent
      ? { pgProvider: { loadPg: () => Promise.resolve({ Pool } as PgModule) } }
      : { pgliteProvider: { loadPGlite: () => Promise.resolve({ PGlite }) } }),
  });
  operations.length = 0;
  return {
    db,
    operations,
    closes: () => closes,
    hook(value: typeof hook) {
      hook = value;
    },
  };
}
for (const concurrent of [false, true]) {
  const mode = concurrent ? "pooled" : "exclusive";
  Deno.test(`${mode}: uncertain BEGIN drains and rolls back before later work`, async () => {
    const f = await fixture(concurrent, 40);
    const entered = gate();
    const release = gate();
    let called = false;
    f.hook(async (sql) => {
      if (sql === (concurrent ? "BEGIN;\nSELECT first" : "BEGIN")) {
        entered.resolve();
        await release.promise;
      }
    });
    try {
      const transaction = f.db.transaction(async (tx) => {
        await tx.query("SELECT first");
        called = true;
      });
      const rejected = assertRejects(() => transaction, Error, "timed out");
      await entered.promise;
      await new Promise((done) => setTimeout(done, 80));
      release.resolve();
      await rejected;
      await f.db.query("SELECT after");
      assertEquals(called, false);
      assertEquals(f.operations.map((sql) => sql.slice(sql.indexOf(":") + 1)), [
        ...(concurrent ? ["BEGIN;\nSELECT first"] : ["BEGIN", "SELECT first"]),
        "ROLLBACK",
        "SELECT after",
      ]);
      assertEquals(
        f.operations[0].split(":")[0],
        f.operations[1].split(":")[0],
      );
    } finally {
      release.resolve();
      await f.db.close();
    }
  });
  for (const fail of [false, true]) {
    Deno.test(`${mode}: retained transaction refuses after callback ${fail ? "failure" : "success"}`, async () => {
      const f = await fixture(concurrent);
      let retained: OminipgTransaction | undefined;
      try {
        const operation = f.db.transaction(async (tx) => {
          retained = tx;
          await tx.query("SELECT inside");
          if (fail) throw new Error("callback failed");
        });
        if (fail) {
          await assertRejects(() => operation, Error, "callback failed");
        } else await operation;
        const before = [...f.operations];
        await assertRejects(
          () => retained!.query("SELECT stale"),
          Error,
          "closed",
        );
        await assertRejects(
          () => retained!.queryRaw("SELECT stale alias"),
          Error,
          "closed",
        );
        assertEquals(f.operations, before);
      } finally {
        await f.db.close();
      }
    });
  }
  Deno.test(`${mode}: callback executor seals before COMMIT acknowledgement`, async () => {
    const f = await fixture(concurrent);
    const entered = gate();
    const release = gate();
    let retained: OminipgTransaction | undefined;
    let operation: Promise<unknown> | undefined;
    f.hook(async (sql) => {
      if (sql === "COMMIT") {
        entered.resolve();
        await release.promise;
      }
    });
    try {
      operation = f.db.transaction((tx) => {
        retained = tx;
        return tx.query("SELECT inside");
      });
      await entered.promise;
      const rejected = assertRejects(
        () => retained!.query("SELECT after callback"),
        Error,
        "closed",
      );
      release.resolve();
      await rejected;
      await operation;
      assertEquals(
        f.operations.some((sql) => sql.endsWith("SELECT after callback")),
        false,
      );
    } finally {
      release.resolve();
      await operation?.catch(() => {});
      await f.db.close();
    }
  });
  Deno.test(`${mode}: failed rollback fail-closes before accepting more work`, async () => {
    const f = await fixture(concurrent);
    f.hook((sql) =>
      sql === "ROLLBACK"
        ? Promise.reject(new Error("rollback failed"))
        : Promise.resolve()
    );
    try {
      await assertRejects(
        () =>
          f.db.transaction(async (tx) => {
            await tx.query("SELECT inside");
            throw new Error("callback failed");
          }),
        Error,
        "callback failed",
      );
      await assertRejects(
        () => f.db.query("SELECT after failed rollback"),
        Error,
        "closed",
      );
      assertEquals(f.closes(), 1);
      assertEquals(
        f.operations.some((sql) =>
          sql.endsWith("SELECT after failed rollback")
        ),
        false,
      );
    } finally {
      await f.db.close();
    }
  });
  for (const fail of [false, true]) {
    Deno.test(`${mode}: admitted statement drains before callback ${fail ? "rollback" : "commit"}`, async () => {
      const f = await fixture(concurrent);
      const entered = gate();
      const release = gate();
      let retained: OminipgTransaction | undefined;
      let raw: Promise<unknown> | undefined;
      let operation: Promise<unknown> | undefined;
      f.hook(async (sql) => {
        if (sql === (concurrent ? "BEGIN;\nSELECT held" : "SELECT held")) {
          entered.resolve();
          await release.promise;
        }
      });
      try {
        operation = f.db.transaction((tx) => {
          retained = tx;
          raw = tx.query("SELECT held");
          if (fail) throw new Error("callback failed");
          return 42;
        });
        const outcome = fail
          ? assertRejects(() => operation!, Error, "callback failed")
          : operation;
        await entered.promise;
        await assertRejects(
          () => retained!.query("SELECT late"),
          Error,
          "closed",
        );
        assertEquals(
          f.operations.some((sql) => /:(COMMIT|ROLLBACK)$/.test(sql)),
          false,
        );
        release.resolve();
        await raw;
        await outcome;
        assertEquals(
          f.operations.map((sql) => sql.slice(sql.indexOf(":") + 1)),
          [
            ...(concurrent
              ? ["BEGIN;\nSELECT held"]
              : ["BEGIN", "SELECT held"]),
            fail ? "ROLLBACK" : "COMMIT",
          ],
        );
      } finally {
        release.resolve();
        await operation?.catch(() => {});
        await f.db.close();
      }
    });
  }
  Deno.test(`${mode}: failed rollback cleanup does not wait on concurrent public close`, async () => {
    const f = await fixture(concurrent);
    const entered = gate();
    const release = gate();
    f.hook(async (sql) => {
      if (sql === "ROLLBACK") {
        entered.resolve();
        await release.promise;
        throw new Error("rollback failed");
      }
    });
    let operation: Promise<unknown> | undefined;
    try {
      operation = f.db.transaction(async (tx) => {
        await tx.query("SELECT inside");
        throw new Error("callback failed");
      });
      const rejected = assertRejects(
        () => operation!,
        Error,
        "callback failed",
      );
      await entered.promise;
      const close = f.db.close();
      release.resolve();
      await rejected;
      await close;
      assertEquals(f.closes(), 1);
    } finally {
      release.resolve();
      await operation?.catch(() => {});
      await f.db.close();
    }
  });
}

// Real engines establish that lifetime guards also protect the readonly
// transaction API, not only injected providers.
for (const backend of ["pglite", "postgres"] as const) {
  const url = backend === "postgres" ? Deno.env.get("DB_URL_PG") : ":memory:";
  Deno.test({
    name:
      `real ${backend}: readonly transaction closes retained executor and recovers after rejection`,
    ignore: !url,
    async fn() {
      const { createPGliteProvider } = await import(
        "../src/providers/pglite.ts"
      );
      const { createPgProvider } = await import("../src/providers/pg.ts");
      const db = await Ominipg.connect({
        url: url!,
        pgliteProvider: createPGliteProvider(),
        pgProvider: createPgProvider(),
        pgliteMemoryProfile: "low-memory",
      });
      let retained: OminipgTransaction | undefined;
      try {
        await db.transaction(async (tx) => {
          retained = tx;
          await tx.query(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
          );
          assertEquals(
            (await tx.query(
              "SELECT current_setting('transaction_read_only') AS readonly",
            )).rows,
            [{ readonly: "on" }],
          );
        });
        await assertRejects(() => retained!.query("SELECT 1"), Error, "closed");
        await assertRejects(
          () =>
            db.transaction(async (tx) => {
              retained = tx;
              await tx.query(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
              );
              await tx.query(
                "CREATE TABLE transaction_lifetime_forbidden (id integer)",
              );
            }),
          Error,
          "read-only transaction",
        );
        await assertRejects(
          () => retained!.queryRaw("SELECT 1"),
          Error,
          "closed",
        );
        assertEquals((await db.query("SELECT 1 AS value")).rows, [{
          value: 1,
        }]);
      } finally {
        await db.close();
      }
    },
  });
}

Deno.test("pooled: public close after failed rollback still drains other admitted callbacks", async () => {
  const f = await fixture(true);
  const entered = gate();
  const release = gate();
  let otherDone = false;
  const other = f.db.transaction(async (tx) => {
    await tx.query("SELECT other");
    entered.resolve();
    await release.promise;
  });
  void other.then(() => {
    otherDone = true;
  }, () => {
    otherDone = true;
  });
  await entered.promise;
  f.hook((sql) =>
    sql === "ROLLBACK"
      ? Promise.reject(new Error("rollback fault"))
      : Promise.resolve()
  );
  try {
    await assertRejects(
      () =>
        f.db.transaction(async (tx) => {
          await tx.query("SELECT inside");
          throw new Error("primary");
        }),
      Error,
      "primary",
    );
    let closed = false;
    const close = f.db.close().then(() => {
      closed = true;
    });
    await new Promise((done) => setTimeout(done, 10));
    assertEquals(otherDone, false);
    assertEquals(
      closed,
      false,
      "public close returned before admitted callback drained",
    );
    release.resolve();
    await other.catch(() => {});
    await close;
    assertEquals(otherDone, true);
    assertEquals(closed, true);
    assertEquals(f.closes(), 1);
  } finally {
    release.resolve();
    await other.catch(() => {});
    await f.db.close();
  }
});
