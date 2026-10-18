import { assertEquals, assertRejects } from "@std/assert";
import { OminipgEngine } from "../src/worker/engine.ts";
import { createPGliteProvider } from "../src/providers/pglite.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function create() {
  const engine = new OminipgEngine({ pgliteProvider: createPGliteProvider() });
  await engine.initialize({ url: ":memory:" });
  return engine;
}
Deno.test("engine native snapshot has scoped reads and returns ordinary admission after close", async () => {
  const engine = await create();
  try {
    assertEquals(await engine.openReadSnapshot("one"), "exclusive");
    assertEquals(await engine.queryReadSnapshot("one", "SELECT 42 AS value"), [{
      value: 42,
    }]);
    await assertRejects(
      () => engine.query("SELECT 1"),
      Error,
      "exclusive snapshot",
    );
    await assertRejects(
      () => engine.queryReadSnapshot("one", "SELECT 1", [], true),
      Error,
      "current lane",
    );
    await assertRejects(
      () => engine.openReadSnapshot("two"),
      Error,
      "already active",
    );
    await assertRejects(
      () => engine.closeReadSnapshot("wrong"),
      Error,
      "does not match",
    );
    await engine.closeReadSnapshot("one");
    await assertRejects(
      () => engine.queryReadSnapshot("one", "SELECT 1"),
      Error,
      "not active",
    );
    assertEquals(await engine.query("SELECT 43 AS value"), [{ value: 43 }]);
    assertEquals(await engine.openReadSnapshot("two"), "exclusive");
    await engine.closeReadSnapshot("two");
  } finally {
    await engine.close();
  }
});
Deno.test("engine snapshot drains preceding ordinary work before actual idle proof", async () => {
  const engine = await create();
  const held = gate();
  const entered = gate();
  const db = engine.state.mainDb!;
  const query = db.query.bind(db);
  db.query = async (...args) => {
    if (args[0] === "SELECT 41 AS value") {
      entered.resolve();
      await held.promise;
    }
    return await query(...args);
  };
  let ordinary: Promise<unknown> | undefined;
  let opening: Promise<unknown> | undefined;
  try {
    ordinary = engine.query("SELECT 41 AS value");
    await entered.promise;
    let opened = false;
    opening = engine.openReadSnapshot("held").then((value) => {
      opened = true;
      return value;
    });
    await assertRejects(
      () => engine.query("SELECT late"),
      Error,
      "exclusive snapshot",
    );
    await Promise.resolve();
    assertEquals(opened, false);
    held.resolve();
    assertEquals(await ordinary, [{ value: 41 }]);
    await opening;
    assertEquals(await engine.queryReadSnapshot("held", "SELECT 42 AS value"), [
      { value: 42 },
    ]);
  } finally {
    held.resolve();
    await ordinary?.catch(() => {});
    await opening?.catch(() => {});
    await engine.close();
  }
});
Deno.test("engine snapshot refuses an existing manual transaction without consuming its work", async () => {
  const engine = await create();
  try {
    await engine.query("CREATE TABLE probe(value integer)");
    await engine.query("BEGIN");
    await engine.query("INSERT INTO probe VALUES(42)");
    await assertRejects(() => engine.openReadSnapshot("busy"), Error, "idle");
    assertEquals(await engine.query("SELECT value FROM probe"), [{
      value: 42,
    }]);
    await engine.query("COMMIT");
    await engine.openReadSnapshot("idle");
    assertEquals(
      await engine.queryReadSnapshot("idle", "SELECT value FROM probe"),
      [{ value: 42 }],
    );
  } finally {
    await engine.close();
  }
});
Deno.test("engine close cancels snapshot opening after preceding raw work drains", async () => {
  const engine = await create();
  const held = gate();
  const entered = gate();
  const db = engine.state.mainDb!;
  const query = db.query.bind(db);
  db.query = async (...args) => {
    entered.resolve();
    await held.promise;
    return await query(...args);
  };
  const ordinary = engine.query("SELECT 1");
  await entered.promise;
  const opening = engine.openReadSnapshot("opening");
  // Observe expected rejection before triggering close.
  const refused = assertRejects(() => opening, Error, "closed");
  const closed = engine.close();
  held.resolve();
  await ordinary;
  await refused;
  await closed;
  await assertRejects(() => engine.query("SELECT 1"), Error, "closed");
});
Deno.test("engine close drains a live native snapshot without waiting on itself", async () => {
  const engine = await create();
  await engine.openReadSnapshot("live");
  const first = engine.close();
  assertEquals(engine.close(), first);
  await first;
  await assertRejects(
    () => engine.queryReadSnapshot("live", "SELECT 1"),
    Error,
    "closed",
  );
});
Deno.test("exclusive snapshot refuses sync state before claim and preserves ordinary use", async () => {
  const engine = await create();
  try {
    engine.state.syncStarted = true;
    await assertRejects(
      () => engine.openReadSnapshot("sync"),
      Error,
      "background sync",
    );
    engine.state.syncStarted = false;
    assertEquals(await engine.query("SELECT 42 AS value"), [{ value: 42 }]);
    await engine.openReadSnapshot("normal");
  } finally {
    engine.state.syncStarted = false;
    await engine.close();
  }
});
const pgUrl = Deno.env.get("DB_URL_PG");
Deno.test({
  name:
    "pooled snapshot control progresses while ordinary checkout waits for the reserved pair",
  ignore: !pgUrl,
  async fn() {
    const { createPgProvider } = await import("../src/providers/pg.ts");
    const engine = new OminipgEngine({ pgProvider: createPgProvider() });
    let ordinary: Promise<unknown> | undefined;
    try {
      await engine.initialize({ url: pgUrl!, pgPoolMax: 2 });
      await engine.query(
        "CREATE TABLE IF NOT EXISTS engine_snapshot_probe(value integer)",
      );
      await engine.query("TRUNCATE engine_snapshot_probe");
      await engine.query("INSERT INTO engine_snapshot_probe VALUES(10)");
      assertEquals(await engine.openReadSnapshot("pooled"), "pooled");
      assertEquals(
        await engine.queryReadSnapshot(
          "pooled",
          "SELECT value FROM engine_snapshot_probe",
        ),
        [{ value: 10 }],
      );
      let done = false;
      ordinary = engine.query("SELECT 42 AS answer").then((value) => {
        done = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assertEquals(done, false);
      await engine.queryReadSnapshot("pooled", "BEGIN", [], true);
      await engine.queryReadSnapshot(
        "pooled",
        "UPDATE engine_snapshot_probe SET value=20",
        [],
        true,
      );
      await engine.queryReadSnapshot("pooled", "COMMIT", [], true);
      assertEquals(
        await engine.queryReadSnapshot(
          "pooled",
          "SELECT value FROM engine_snapshot_probe",
        ),
        [{ value: 10 }],
      );
      await engine.closeReadSnapshot("pooled");
      assertEquals(await ordinary, [{ answer: 42 }]);
      assertEquals(
        await engine.query("SELECT value FROM engine_snapshot_probe"),
        [{ value: 20 }],
      );
      await engine.query("DROP TABLE engine_snapshot_probe");
    } finally {
      await engine.close();
      await ordinary?.catch(() => {});
    }
  },
});
Deno.test({
  name:
    "pooled engine close returns its snapshot pair before waiting ordinary pool shutdown",
  ignore: !pgUrl,
  async fn() {
    const { createPgProvider } = await import("../src/providers/pg.ts");
    const engine = new OminipgEngine({ pgProvider: createPgProvider() });
    let ordinary: Promise<unknown> | undefined;
    try {
      await engine.initialize({ url: pgUrl!, pgPoolMax: 2 });
      await engine.openReadSnapshot("closing");
      ordinary = engine.query("SELECT 42 AS answer");
      await engine.close();
      assertEquals(await ordinary, [{ answer: 42 }]);
    } finally {
      await engine.close();
      await ordinary?.catch(() => {});
    }
  },
});
Deno.test({
  name: "pooled snapshot saturation preserves ordinary pool-one behavior",
  ignore: !pgUrl,
  async fn() {
    const { createPgProvider } = await import("../src/providers/pg.ts");
    const engine = new OminipgEngine({ pgProvider: createPgProvider() });
    try {
      await engine.initialize({ url: pgUrl!, pgPoolMax: 1 });
      await assertRejects(
        () => engine.openReadSnapshot("full"),
        Error,
        "capacity",
      );
      assertEquals(await engine.query("SELECT 42 AS answer"), [{ answer: 42 }]);
    } finally {
      await engine.close();
    }
  },
});
Deno.test("engine close retains rollback failure when opening was cancelled", async () => {
  const engine = await create();
  const entered = gate(), held = gate();
  const failure = new Error("rollback failed");
  engine.state.mainDb!.exclusiveSnapshotProvider = () =>
    Promise.resolve({
      isInTransaction: () => false,
      transaction: (callback) =>
        callback({
          async query() {
            entered.resolve();
            await held.promise;
            return { rows: [] };
          },
          rollback: () => Promise.reject(failure),
        }),
    });
  const opening = engine.openReadSnapshot("opening");
  const observed = opening.catch((error) => error);
  await entered.promise;
  const closing = engine.close();
  held.resolve();
  const openError = await observed;
  const closeError = await assertRejects(
    () => closing,
    AggregateError,
    "rollback",
  );
  assertEquals(closeError, openError);
  await assertRejects(
    () => engine.closeReadSnapshot("opening"),
    AggregateError,
    "rollback",
  );
  assertEquals(engine.close(), closing);
  await assertRejects(() => engine.close(), AggregateError, "rollback");
});
for (const failedReturn of [false, true]) {
  Deno.test(`engine partial acquisition ${failedReturn ? "quarantines unknown cleanup" : "preserves ordinary use after confirmed return"}`, async () => {
    const { PgPairCleanupError } = await import(
      "../src/worker/pool-capacity.ts"
    );
    type Client = import("../src/shared/types.ts").PgPoolClient;
    let connects = 0, releaseFails = failedReturn, ends = 0;
    const checkoutError = new Error("second checkout failed");
    const returnError = new Error("physical return failed");
    function client(fault = false): Client {
      const value = {
        query: () => Promise.resolve({ rows: [{ value: 42 }] }),
        release() {
          if (fault && releaseFails) throw returnError;
        },
        on: () => value,
        removeListener: () => value,
      };
      return value as Client;
    }
    class Pool {
      options = { max: 2 };
      connect() {
        connects++;
        return connects === 3
          ? Promise.reject(checkoutError)
          : Promise.resolve(client(connects === 2));
      }
      end() {
        ends++;
        return Promise.resolve();
      }
    }
    const engine = new OminipgEngine({
      pgProvider: { loadPg: () => Promise.resolve({ Pool }) },
    });
    await engine.initialize({
      url: "postgres://fixture/fixture",
      pgPoolMax: 2,
    });
    const pool = engine.state.mainPool!;
    try {
      if (failedReturn) {
        const error = await assertRejects(
          () => engine.openReadSnapshot("partial"),
          AggregateError,
        );
        const acquisition = error.errors[0] as InstanceType<
          typeof PgPairCleanupError
        >;
        assertEquals(acquisition instanceof PgPairCleanupError, true);
        assertEquals(acquisition.errors, [checkoutError, returnError]);
        await assertRejects(() => engine.query("SELECT late"), Error, "closed");
        await assertRejects(
          () => engine.closeReadSnapshot("partial"),
          AggregateError,
        );
        releaseFails = false;
        await pool.end();
        await assertRejects(() => engine.close(), AggregateError);
      } else {
        const error = await assertRejects(
          () => engine.openReadSnapshot("partial"),
          Error,
          "checkout failed",
        );
        assertEquals(error, checkoutError);
        assertEquals(await engine.query("SELECT 42 AS value"), [{ value: 42 }]);
      }
    } finally {
      releaseFails = false;
      await pool.end();
      await engine.close().catch(() => {});
      assertEquals(ends, 1);
    }
  });
}
