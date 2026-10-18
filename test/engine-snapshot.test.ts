import { assertEquals, assertRejects } from "@std/assert";
import { OminipgEngine } from "../src/worker/engine.ts";

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
