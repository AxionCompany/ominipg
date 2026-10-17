import { assertEquals, assertRejects } from "@std/assert";
import {
  createEngineState,
  initConnections,
  requireMainDb,
} from "../src/worker/db.ts";
import type { PgModule, PgPoolClient } from "../src/shared/types.ts";
import { transactionControl } from "../src/worker/transaction-control.ts";
import { Ominipg } from "../src/client/index.ts";
import { createPgProvider } from "../src/providers/pg.ts";

async function fixture() {
  const clients: Array<{ queries: string[]; releases: boolean[] }> = [];
  let fail: string | undefined;
  class Pool {
    connect() {
      const client = {
        queries: [] as string[],
        releases: [] as boolean[],
        query(sql: string) {
          this.queries.push(sql);
          if (sql === fail) {
            return Promise.reject(new Error("injected query failure"));
          }
          return Promise.resolve({ rows: [] });
        },
        release(destroy = false) {
          this.releases.push(destroy);
        },
      };
      clients.push(client);
      return Promise.resolve(client as unknown as PgPoolClient);
    }
    end() {
      return Promise.resolve();
    }
  }
  const state = createEngineState({
    pgProvider: { loadPg: () => Promise.resolve({ Pool } as PgModule) },
  });
  await initConnections(state, { url: "postgres://test/test" });
  return {
    db: requireMainDb(state),
    clients,
    fail(sql: string | undefined) {
      fail = sql;
    },
  };
}

Deno.test("PostgreSQL savepoint rollback keeps the transaction lane pinned", async () => {
  const f = await fixture();
  try {
    await f.db.query("BEGIN", [], "lane");
    const client = f.clients.at(-1)!;
    await f.db.query("SAVEPOINT step", [], "lane");
    await f.db.query("ROLLBACK TO SAVEPOINT step", [], "lane");
    assertEquals(client.releases, []);
    await f.db.query("RELEASE SAVEPOINT step", [], "lane");
    await f.db.query("SELECT 2", [], "lane");
    await f.db.query("COMMIT", [], "lane");
    assertEquals(client.releases, [false]);
    assertEquals(f.clients.length, 2); // One startup probe, one transaction.
  } finally {
    await f.db.close();
  }
});

Deno.test("savepoint grammar and comments do not finish the outer transaction", async () => {
  const f = await fixture();
  try {
    await f.db.query("/* before BEGIN */ -- comment\n BEGIN WORK;", [], "lane");
    const client = f.clients.at(-1)!;
    for (
      const sql of [
        "ROLLBACK TO step",
        "-- CR comment\rROLLBACK TO step",
        "-- CRLF comment\r\nROLLBACK TO step",
        "rollback work to savepoint step;",
        "RoLlBaCk TRANSACTION\nTO step",
        "-- rollback\nROLLBACK/* nested /* comment */ */WORK/* gap */TO SAVEPOINT step",
        'ROLLBACK TO SAVEPOINT "name;COMMIT"; -- end',
        'ROLLBACK TO "quoted"";END"',
      ]
    ) {
      await f.db.query(sql, [], "lane");
      assertEquals(client.releases, [], sql);
      await f.db.query("SELECT still_in_transaction", [], "lane");
    }
    await f.db.query("COMMIT", [], "lane");
    assertEquals(client.releases, [false]);
  } finally {
    await f.db.close();
  }
});

Deno.test("failed savepoint rollback keeps the pinned client for full rollback", async () => {
  const f = await fixture();
  try {
    await f.db.query("BEGIN", [], "lane");
    const client = f.clients.at(-1)!;
    f.fail("ROLLBACK TO missing");
    await assertRejects(
      () => f.db.query("ROLLBACK TO missing", [], "lane"),
      Error,
      "injected query failure",
    );
    assertEquals(client.releases, []);
    await f.db.query("ROLLBACK", [], "lane");
    assertEquals(client.releases, [false]);
  } finally {
    await f.db.close();
  }
});

Deno.test("full transaction endings and aliases release exactly once", async () => {
  const f = await fixture();
  try {
    for (
      const sql of [
        "COMMIT",
        "ROLLBACK",
        "END WORK",
        "ABORT TRANSACTION",
        "COMMIT AND NO CHAIN",
        "ROLLBACK WORK AND NO CHAIN",
        "/* before */ END; -- after",
      ]
    ) {
      await f.db.query("START TRANSACTION", [], "lane");
      const client = f.clients.at(-1)!;
      await f.db.query(sql, [], "lane");
      assertEquals(client.releases, [false], sql);
      await assertRejects(
        () => f.db.query("SELECT 1", [], "lane"),
        Error,
        "not active",
      );
    }
  } finally {
    await f.db.close();
  }
});

Deno.test("successful AND CHAIN retains the same transaction lane", async () => {
  const f = await fixture();
  try {
    await f.db.query("BEGIN", [], "lane");
    const client = f.clients.at(-1)!;
    for (
      const sql of [
        "COMMIT AND CHAIN",
        "ROLLBACK WORK AND CHAIN",
        "END TRANSACTION AND CHAIN",
        "ABORT /* gap */ AND CHAIN",
      ]
    ) {
      await f.db.query(sql, [], "lane");
      assertEquals(client.releases, []);
      await f.db.query("SELECT next_transaction", [], "lane");
    }
    await f.db.query("ROLLBACK", [], "lane");
    assertEquals(client.releases, [false]);
  } finally {
    await f.db.close();
  }
});

Deno.test("failed full transaction endings discard the client instead of pooling it", async () => {
  const f = await fixture();
  try {
    for (
      const sql of [
        "COMMIT",
        "ROLLBACK",
        "END",
        "ABORT",
        "COMMIT AND CHAIN",
        "ROLLBACK AND CHAIN",
      ]
    ) {
      f.fail(undefined);
      await f.db.query("BEGIN", [], "lane");
      const client = f.clients.at(-1)!;
      f.fail(sql);
      await assertRejects(
        () => f.db.query(sql, [], "lane"),
        Error,
        "injected query failure",
      );
      assertEquals(client.releases, [true], sql);
      await assertRejects(
        () => f.db.query("SELECT 1", [], "lane"),
        Error,
        "not active",
      );
    }
  } finally {
    await f.db.close();
  }
});

Deno.test("prepared-transaction commands are not endings of the current lane", async () => {
  const f = await fixture();
  try {
    await f.db.query("BEGIN", [], "lane");
    const client = f.clients.at(-1)!;
    for (
      const sql of [
        "COMMIT PREPARED 'other;id'",
        "ROLLBACK PREPARED $tag$other;id$tag$",
      ]
    ) {
      f.fail(sql); // PostgreSQL refuses these inside a transaction block.
      await assertRejects(
        () => f.db.query(sql, [], "lane"),
        Error,
        "injected query failure",
      );
      assertEquals(client.releases, []);
    }
    f.fail(undefined);
    await f.db.query("ROLLBACK", [], "lane");
    assertEquals(client.releases, [false]);
  } finally {
    await f.db.close();
  }
});

Deno.test("control-led batches are refused before any SQL or release", async () => {
  const f = await fixture();
  try {
    await f.db.query("BEGIN", [], "lane");
    const client = f.clients.at(-1)!;
    for (
      const sql of [
        "COMMIT; BEGIN",
        "ROLLBACK TO step; COMMIT",
        "BEGIN; SELECT 1",
        "END; /* gap */ SELECT 2",
      ]
    ) {
      const queries = client.queries.length;
      await assertRejects(
        () => f.db.query(sql, [], "lane"),
        Error,
        "one at a time",
      );
      assertEquals(client.queries.length, queries);
      assertEquals(client.releases, []);
    }
    await f.db.query("ROLLBACK", [], "lane");
  } finally {
    await f.db.close();
  }
});

Deno.test("ordinary SQL and quoted/function bodies remain outside control parsing", () => {
  for (
    const sql of [
      "SELECT 'ROLLBACK; COMMIT'",
      'SELECT "END"',
      "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END $$; SELECT 1;",
      "CREATE FUNCTION f() RETURNS int LANGUAGE SQL BEGIN ATOMIC SELECT 1; END;",
      // Later embedded transaction control remains unsupported, not falsely classified.
      "SELECT 1; COMMIT",
    ]
  ) assertEquals(transactionControl(sql), { kind: "other" });
  assertEquals(transactionControl("COMMIT PREPARED E'quoted\\';id';"), {
    kind: "other",
  });
  assertEquals(transactionControl("COMMIT; /* trailing */ ; -- comment"), {
    kind: "end",
    chain: false,
  });
});

Deno.test("closing after a failed full rollback destroys the pinned client", async () => {
  const f = await fixture();
  await f.db.query("BEGIN", [], "lane");
  const client = f.clients.at(-1)!;
  f.fail("ROLLBACK");
  await f.db.close();
  assertEquals(client.releases, [true]);
});

const url = Deno.env.get("DB_URL_PG");
Deno.test({
  name:
    "real PostgreSQL savepoint rollback retains backend and atomic sibling effects",
  ignore: !url,
  async fn() {
    const db = await Ominipg.connect({
      url: url!,
      pgProvider: createPgProvider(),
      pgPoolMax: 1,
    });
    const table = `savepoint_test_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await db.query(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
      await db.transaction(async (tx) => {
        const before = (await tx.query(
          "SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid",
        )).rows;
        await tx.query(`INSERT INTO ${table} VALUES(1)`);
        await tx.query("SAVEPOINT step");
        await tx.query(`INSERT INTO ${table} VALUES(2)`);
        await tx.query("ROLLBACK WORK TO SAVEPOINT step");
        await tx.query("RELEASE SAVEPOINT step");
        await tx.query(`INSERT INTO ${table} VALUES(3)`);
        const after = (await tx.query(
          "SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid",
        )).rows;
        assertEquals(after, before);
      });
      assertEquals(
        (await db.query(`SELECT id FROM ${table} ORDER BY id`)).rows,
        [{ id: 1 }, { id: 3 }],
      );
      await assertRejects(
        () =>
          db.transaction(async (tx) => {
            await tx.query(`INSERT INTO ${table} VALUES(4)`);
            await tx.query("ROLLBACK TRANSACTION TO missing");
          }),
        Error,
        "does not exist",
      );
      assertEquals(
        (await db.query(`SELECT id FROM ${table} ORDER BY id`)).rows,
        [{ id: 1 }, { id: 3 }],
      );
    } finally {
      await db.query(`DROP TABLE IF EXISTS ${table}`);
      await db.close();
    }
  },
});

Deno.test({
  name: "real PostgreSQL CR and CRLF comments preserve BEGIN lane ownership",
  ignore: !url,
  async fn() {
    const state = createEngineState({ pgProvider: createPgProvider() });
    await initConnections(state, { url: url!, pgPoolMax: 1 });
    const db = requireMainDb(state);
    try {
      for (const newline of ["\r", "\r\n", "\n"]) {
        await db.query(`-- comment${newline}BEGIN`, [], "lane");
        await db.query("SELECT pg_backend_pid()", [], "lane");
        await db.query(`-- comment${newline}ROLLBACK`, [], "lane");
        await assertRejects(
          () => db.query("SELECT 1", [], "lane"),
          Error,
          "not active",
        );
      }
    } finally {
      await db.close();
    }
  },
});
