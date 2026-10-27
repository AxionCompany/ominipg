import { createHypervisor } from "@oxian/oxian-js/hypervisor";
import { createWorker } from "@oxian/oxian-js/worker";
import { createOminipgWorkload } from "../src/session/workload.ts";
import {
  decodeSessionFrames,
  encodeSessionFrame,
} from "../src/session/codec.ts";
import { OMINIPG_SESSION_WORKLOAD } from "../src/session/protocol.ts";
import { EventEmitter } from "node:events";
import { assertEquals, assertRejects } from "@std/assert";
import {
  Ominipg,
  type OminipgTransactionOptions,
} from "../src/client/index.ts";
import type { PgModule, PgPoolClient } from "../src/shared/types.ts";
import { createPgProvider } from "../src/providers/pg.ts";
import { createPGliteProvider } from "../src/providers/pglite.ts";

async function fixture(fail?: string) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  class Pool {
    connect() {
      return Promise.resolve(Object.assign(new EventEmitter(), {
        query(sql: string, params?: unknown[]) {
          calls.push({ sql, params });
          if (sql.includes(fail ?? "\0")) {
            return Promise.reject(new Error("first query failed"));
          }
          return Promise.resolve(
            sql.startsWith("BEGIN;")
              ? [
                { rows: [] },
                { rows: [{ value: 1 }] },
                ...(sql.endsWith("COMMIT") ? [{ rows: [] }] : []),
              ]
              : sql.endsWith(";\nCOMMIT")
              ? [{ rows: [{ value: 1 }] }, { rows: [] }]
              : { rows: [{ value: 1 }] },
          );
        },
        release() {},
      }) as unknown as PgPoolClient);
    }
    end() {
      return Promise.resolve();
    }
  }
  const db = await Ominipg.connect({
    url: "postgres://test/test",
    pgProvider: { loadPg: () => Promise.resolve({ Pool } as PgModule) },
  });
  calls.length = 0;
  return { db, calls };
}

Deno.test("callback round trips: N statements use N + 1 queries; empty sends nothing", async () => {
  const { db, calls } = await fixture();
  try {
    for (const n of [0, 1, 3]) {
      calls.length = 0;
      await db.transaction(async (tx) => {
        for (let i = 0; i < n; i++) {
          assertEquals((await tx.query("SELECT 1 AS value")).rows, [{
            value: 1,
          }]);
        }
      });
      assertEquals(calls.length, n === 0 ? 0 : n + 1, `N=${n}`);
      if (n) assertEquals(calls[0].sql, "BEGIN;\nSELECT 1 AS value");
    }
    calls.length = 0;
    await assertRejects(
      () =>
        db.transaction(() => {
          throw new Error("empty");
        }),
      Error,
      "empty",
    );
    assertEquals(calls, []);
  } finally {
    await db.close();
  }
});

Deno.test("read-only repeatable-read BEGIN removes SET TRANSACTION round trip", async () => {
  const { db, calls } = await fixture();
  try {
    await db.transaction((tx) => tx.query("SELECT 1"), {
      isolation: "repeatable read",
      readOnly: true,
    });
    assertEquals(calls.map(({ sql }) => sql), [
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT 1",
      "COMMIT",
    ]);
    calls.length = 0;
    await db.transaction((tx) => tx.query("SELECT $1::int", [7]), {
      isolation: "serializable",
      readOnly: false,
    });
    assertEquals(calls, [
      { sql: "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE", params: [] },
      { sql: "SELECT $1::int", params: [7] },
      { sql: "COMMIT", params: [] },
    ]);
  } finally {
    await db.close();
  }
});

Deno.test("failed first batch rolls back before the next transaction", async () => {
  const { db, calls } = await fixture("broken");
  try {
    await assertRejects(
      () => db.transaction((tx) => tx.query("SELECT broken")),
      Error,
      "first query failed",
    );
    await db.transaction((tx) => tx.query("SELECT 1"));
    assertEquals(calls.map(({ sql }) => sql), [
      "BEGIN;\nSELECT broken",
      "ROLLBACK",
      "BEGIN;\nSELECT 1",
      "COMMIT",
    ]);
  } finally {
    await db.close();
  }
});

Deno.test("invalid transaction options are rejected before callback or SQL", async () => {
  const { db, calls } = await fixture();
  try {
    for (
      const options of [null, [], { isolation: "serializable; COMMIT" }, {
        readOnly: "true",
      }]
    ) {
      let called = false;
      await assertRejects(() =>
        db.transaction(() => {
          called = true;
        }, options as OminipgTransactionOptions), TypeError);
      assertEquals(called, false);
    }
    assertEquals(calls, []);
  } finally {
    await db.close();
  }
});

for (const backend of ["pglite", "postgres"] as const) {
  const url = backend === "postgres" ? Deno.env.get("DB_URL_PG") : ":memory:";
  Deno.test({
    name:
      `real ${backend}: transaction options, first-statement failures, and recovery`,
    ignore: !url,
    async fn() {
      const db = await Ominipg.connect({
        url: url!,
        pgPoolMax: 1,
        pgProvider: createPgProvider(),
        pgliteProvider: createPGliteProvider(),
      });
      const table = `omini_tx_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        await db.query(`CREATE TABLE ${table} (id integer)`);
        for (
          const isolation of [
            "read committed",
            "repeatable read",
            "serializable",
          ] as const
        ) {
          await db.transaction(async (tx) => {
            assertEquals((await tx.query("SHOW transaction_isolation")).rows, [{
              transaction_isolation: isolation,
            }]);
            assertEquals((await tx.query("SHOW transaction_read_only")).rows, [{
              transaction_read_only: "on",
            }]);
          }, { isolation, readOnly: true });
        }
        for (
          const [sql, params, error] of [
            [`INSERT INTO ${table} VALUES (1)`, [], "read-only transaction"],
            [`INSERT INTO ${table} VALUES ($1)`, [1], "read-only transaction"],
            ["SELECT 1 / 0", [], "division by zero"],
            ["SELEC broken", [], "syntax error"],
            ["SELECT $1::int / 0", [1], "division by zero"],
          ] as const
        ) {
          await assertRejects(
            () =>
              db.transaction((tx) => tx.query(sql, [...params]), {
                isolation: "repeatable read",
                readOnly: true,
              }),
            Error,
            error,
          );
          await db.transaction(async (tx) => {
            assertEquals(
              (await tx.query("SELECT $1::int AS value", [9])).rows,
              [{ value: 9 }],
            );
          });
        }
        await db.transaction(async (tx) => {
          await tx.query("SAVEPOINT step");
          await tx.query(`INSERT INTO ${table} VALUES (4)`);
          await tx.query("ROLLBACK TO SAVEPOINT step");
          await tx.query("RELEASE SAVEPOINT step");
        });
        if (backend === "postgres") {
          for (const sql of ["BEGIN", "COMMIT; SELECT 1"]) {
            await db.transaction(async (tx) => {
              await assertRejects(() => tx.query(sql));
              assertEquals((await tx.query("SELECT 1 AS value")).rows, [{
                value: 1,
              }]);
            });
          }
          await db.transaction(async (tx) => {
            assertEquals((await tx.query("-- only a comment")).rows, []);
            assertEquals((await tx.query("SELECT 1 AS value")).rows, [{
              value: 1,
            }]);
          });
        }
        // A simple-protocol parse error can prevent BEGIN itself executing.
        // Catching it must never let a later statement autocommit.
        await assertRejects(() =>
          db.transaction(async (tx) => {
            await assertRejects(() => tx.query("SELEC broken"));
            await tx.query(`INSERT INTO ${table} VALUES (2)`);
          })
        );
        assertEquals((await db.query(`SELECT * FROM ${table}`)).rows, []);
        await db.transaction(
          (tx) => tx.query(`INSERT INTO ${table} VALUES ($1)`, [3]),
          { readOnly: false },
        );
        assertEquals((await db.query(`SELECT * FROM ${table}`)).rows, [{
          id: 3,
        }]);
      } finally {
        await db.query(`DROP TABLE ${table}`);
        await db.close();
      }
    },
  });
}

for (const transactionStart of [false, true]) {
  Deno.test(`older workloads (transactionStart=${transactionStart}) use separate COMMIT for finish`, async () => {
    const sent: string[] = [];
    const transport = {
      type: "in-process",
      config: { topic: crypto.randomUUID() },
    } as const;
    const hypervisor = createHypervisor({ transports: [transport] });
    const handler = createOminipgWorkload({
      dependencies: { pgliteProvider: createPGliteProvider() },
    });
    const worker = createWorker({
      id: crypto.randomUUID(),
      transport,
      capacity: 1,
      workloads: {
        [OMINIPG_SESSION_WORKLOAD]: async (context) => {
          const requests = decodeSessionFrames(context.input);
          const input = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const next = await requests.next();
              if (next.done) {
                controller.close();
                return;
              }
              const request = next.value as {
                payload?: { sql?: string; begin?: unknown; end?: unknown };
              };
              if (request.payload?.sql) sent.push(request.payload.sql);
              assertEquals(request.payload?.end, undefined);
              assertEquals(
                transactionStart ? undefined : request.payload?.begin,
                undefined,
                "Old workloads must never receive implicit transaction startup",
              );
              controller.enqueue(encodeSessionFrame(request));
            },
          });
          const response = await handler({ ...context, input });
          if (
            !response || typeof response !== "object" ||
            !("body" in response) ||
            !(response.body instanceof ReadableStream)
          ) {
            throw new Error("Missing workload stream");
          }
          const frames = decodeSessionFrames(response.body);
          return {
            body: new ReadableStream<Uint8Array>({
              async pull(controller) {
                const next = await frames.next();
                if (next.done) {
                  controller.close();
                  return;
                }
                const frame = next.value as {
                  value?: {
                    transactionStart?: boolean;
                    transactionEnd?: boolean;
                  };
                };
                // Emulate the initialize response from pre-0.11.1 workloads.
                if (frame.value) {
                  if (!transactionStart) delete frame.value.transactionStart;
                  delete frame.value.transactionEnd;
                }
                controller.enqueue(encodeSessionFrame(frame));
              },
            }),
          };
        },
      },
    });
    let db: Ominipg | undefined;
    try {
      await worker.ready;
      db = await Ominipg.connect({
        url: ":memory:",
        oxian: { dispatcher: hypervisor },
      });
      const results = await db.transaction((tx) =>
        Promise.all([
          tx.query("SHOW transaction_isolation"),
          tx.query("SHOW transaction_read_only"),
        ]), { isolation: "repeatable read", readOnly: true });
      assertEquals(results.map((result) => result.rows), [
        [{ transaction_isolation: "repeatable read" }],
        [{ transaction_read_only: "on" }],
      ]);
      sent.length = 0;
      const value = await db.transaction(async (tx) => {
        const pending = tx.query("SELECT 1");
        const finished = tx.finish("SELECT $1::int AS value", [5]);
        await pending;
        assertEquals((await finished).rows, [{ value: 5 }]);
        await assertRejects(
          () => tx.query("SELECT 2"),
          Error,
          "Ominipg transaction is closed.",
        );
        return 42;
      });
      assertEquals(value, 42);
      assertEquals(sent, [
        ...(transactionStart ? [] : ["BEGIN"]),
        "SELECT 1",
        "SELECT $1::int AS value",
        "COMMIT",
      ]);
      sent.length = 0;
      assertEquals(
        (await db.transaction((tx) => tx.finish("SELECT 6 AS value"))).rows,
        [{ value: 6 }],
      );
      assertEquals(sent, [
        ...(transactionStart ? [] : ["BEGIN"]),
        "SELECT 6 AS value",
        "COMMIT",
      ]);
    } finally {
      await db?.close();
      await worker.stop("test_finished");
      await hypervisor.shutdown("test_finished");
    }
  });
}

Deno.test({
  name:
    "real postgres: a multi-statement first query returns only its own results",
  ignore: !Deno.env.get("DB_URL_PG"),
  async fn() {
    const db = await Ominipg.connect({
      url: Deno.env.get("DB_URL_PG")!,
      pgProvider: createPgProvider(),
    });
    try {
      const outside = await db.query("SELECT 1 AS a; SELECT 2 AS b");
      const inside = await db.transaction((tx) =>
        tx.query("SELECT 1 AS a; SELECT 2 AS b")
      );
      // Callers observe the same result with or without the deferred BEGIN.
      assertEquals(inside, outside);
    } finally {
      await db.close();
    }
  },
});

Deno.test("finish round trips: N statements use N queries, including a single finish", async () => {
  const { db, calls } = await fixture();
  try {
    for (const n of [1, 3]) {
      calls.length = 0;
      const result = await db.transaction(async (tx) => {
        for (let i = 1; i < n; i++) await tx.query("SELECT 1 AS value");
        assertEquals((await tx.finish("SELECT 1 AS value")).rows, [{
          value: 1,
        }]);
        return "callback result";
      });
      assertEquals(result, "callback result");
      assertEquals(calls.length, n, `N=${n}`);
      assertEquals(
        calls.at(-1)?.sql,
        `${n === 1 ? "BEGIN;\n" : ""}SELECT 1 AS value\n;\nCOMMIT`,
      );
    }
    calls.length = 0;
    await db.transaction(async (tx) => {
      await tx.query("SELECT 1");
      await tx.finish("SELECT $1::int AS value", [1]);
    });
    assertEquals(calls, [
      { sql: "BEGIN;\nSELECT 1", params: [] },
      { sql: "SELECT $1::int AS value", params: [1] },
      { sql: "COMMIT", params: [] },
    ]);
    calls.length = 0;
    await db.transaction((tx) => tx.finish("SELECT $1::int AS value", [1]));
    assertEquals(calls.map(({ sql }) => sql), [
      "BEGIN",
      "SELECT $1::int AS value",
      "COMMIT",
    ]);
  } finally {
    await db.close();
  }
});

for (const backend of ["pglite", "postgres"] as const) {
  const url = backend === "postgres" ? Deno.env.get("DB_URL_PG") : ":memory:";
  Deno.test({
    name:
      `real ${backend}: finish commits, returns rows, closes, and recovers from statement and COMMIT errors`,
    ignore: !url,
    async fn() {
      const db = await Ominipg.connect({
        url: url!,
        pgPoolMax: 1,
        pgProvider: createPgProvider(),
        pgliteProvider: createPGliteProvider(),
      });
      const observer = backend === "postgres"
        ? await Ominipg.connect({ url: url!, pgProvider: createPgProvider() })
        : db;
      const table = `omini_finish_${crypto.randomUUID().replaceAll("-", "")}`;
      try {
        await db.query(
          `CREATE TABLE ${table} (id integer UNIQUE DEFERRABLE INITIALLY DEFERRED)`,
        );
        for (const params of [undefined, [2]]) {
          const id = params ? 2 : 1;
          assertEquals(
            await db.transaction(async (tx) => {
              assertEquals(
                (await tx.finish<{ id: number }>(
                  `INSERT INTO ${table} VALUES (${
                    params ? "$1" : id
                  }) RETURNING id`,
                  params,
                )).rows,
                [{ id }],
              );
              for (const operation of [tx.query, tx.queryRaw, tx.finish]) {
                await assertRejects(
                  () => operation("SELECT 1"),
                  Error,
                  "Ominipg transaction is closed.",
                );
              }
              return id;
            }),
            id,
          );
          assertEquals(
            (await observer.query(`SELECT id FROM ${table} WHERE id = ${id}`))
              .rows,
            [{ id }],
          );
        }
        for (const first of [true, false]) {
          for (const parameterized of [false, true]) {
            for (const commitFailure of [false, true]) {
              await assertRejects(
                () =>
                  db.transaction(async (tx) => {
                    if (!first) {
                      await tx.query(`INSERT INTO ${table} VALUES (99)`);
                    }
                    const sql = commitFailure
                      ? `INSERT INTO ${table} VALUES (${
                        parameterized ? "$1" : "1"
                      })`
                      : `SELECT ${parameterized ? "$1::int" : "1"} / 0`;
                    // Even a caught finish error must reject the enclosing transaction.
                    await assertRejects(
                      () => tx.finish(sql, parameterized ? [1] : undefined),
                      Error,
                      commitFailure ? "duplicate key" : "division by zero",
                    );
                  }),
                Error,
                commitFailure ? "duplicate key" : "division by zero",
              );
              assertEquals(
                (await observer.query(`SELECT id FROM ${table} ORDER BY id`))
                  .rows,
                [{ id: 1 }, { id: 2 }],
              );
              assertEquals(
                (await db.transaction((tx) => tx.finish("SELECT 7 AS value")))
                  .rows,
                [{ value: 7 }],
              );
            }
          }
        }
        await assertRejects(
          () => db.transaction((tx) => tx.finish("SELEC broken")),
          Error,
          "syntax error",
        );
        assertEquals(
          (await db.transaction((tx) => tx.finish("SELECT 8 AS value"))).rows,
          [{ value: 8 }],
        );
        if (backend === "postgres") {
          assertEquals(
            (await db.transaction((tx) =>
              tx.finish("SELECT 9 AS value -- trailing comment")
            )).rows,
            [{ value: 9 }],
          );
        }
      } finally {
        await db.query(`DROP TABLE ${table}`);
        if (observer !== db) await observer.close();
        await db.close();
      }
    },
  });
}

Deno.test("real pglite: finish data survives reopening in another session", async () => {
  const path = await Deno.makeTempDir({ prefix: "omini_finish_" });
  const options = {
    url: `file://${path}`,
    pgliteProvider: createPGliteProvider(),
  };
  let db: Ominipg | undefined;
  try {
    db = await Ominipg.connect(options);
    await db.query("CREATE TABLE committed (id integer)");
    await db.transaction((tx) =>
      tx.finish("INSERT INTO committed VALUES (1) RETURNING id")
    );
    await db.transaction((tx) =>
      tx.finish("INSERT INTO committed VALUES ($1) RETURNING id", [2])
    );
    await db.close();
    db = await Ominipg.connect(options);
    assertEquals(
      (await db.query("SELECT id FROM committed ORDER BY id")).rows,
      [
        { id: 1 },
        { id: 2 },
      ],
    );
  } finally {
    await db?.close();
    await Deno.remove(path, { recursive: true });
  }
});
