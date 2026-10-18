import { assertEquals, assertRejects } from "@std/assert";
import { PGlite } from "@electric-sql/pglite";
import {
  type ExclusiveSnapshotProvider,
  openExclusiveReadSnapshot,
} from "../src/worker/exclusive-snapshot.ts";
import { lowMemoryPGliteStartParams } from "../src/shared/pglite_config.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const statements: string[] = [];
  let quarantine = 0;
  let rollback = 0;
  let hook: ((sql: string) => Promise<void>) | undefined;
  let rollbackError: Error | undefined;
  let beginError: Error | undefined;
  let idle: boolean = false;
  const provider: ExclusiveSnapshotProvider = {
    isInTransaction: () => idle,
    async transaction(callback) {
      if (beginError) throw beginError;
      return await callback({
        async query(sql) {
          statements.push(sql);
          await hook?.(sql);
          return { rows: [] };
        },
        rollback() {
          rollback++;
          return rollbackError
            ? Promise.reject(rollbackError)
            : Promise.resolve();
        },
      });
    },
  };
  return {
    provider,
    statements,
    open: (signal?: AbortSignal) =>
      openExclusiveReadSnapshot(provider, () => {
        quarantine++;
        return Promise.resolve();
      }, signal),
    quarantine: () => quarantine,
    rollback: () => rollback,
    setHook: (value: typeof hook) => {
      hook = value;
    },
    setRollbackError: (error: Error) => {
      rollbackError = error;
    },
    setBeginError: (error: Error) => {
      beginError = error;
    },
    setBusy: () => {
      idle = true;
    },
  };
}
Deno.test("exclusive snapshot refuses actual existing transaction before native BEGIN", async () => {
  const f = fixture();
  f.setBusy();
  await assertRejects(() => f.open(), Error, "idle");
  assertEquals(f.statements, []);
  assertEquals(f.rollback(), 0);
  assertEquals(f.quarantine(), 0);
});
Deno.test("exclusive snapshot closes retained executor and never auto commits", async () => {
  const f = fixture();
  const reader = await f.open();
  await reader.query("SELECT 1");
  const closed = reader.close();
  await assertRejects(() => reader.query("SELECT late"), Error, "closed");
  await closed;
  await reader.close();
  assertEquals(f.rollback(), 1);
  assertEquals(f.quarantine(), 0);
  assertEquals(f.statements, [
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SELECT 1",
  ]);
});
Deno.test("exclusive snapshot drains actual admitted work before rollback", async () => {
  const f = fixture();
  const held = gate();
  f.setHook((sql) => sql === "SELECT held" ? held.promise : Promise.resolve());
  const reader = await f.open();
  const raw = reader.query("SELECT held");
  const closed = reader.close();
  await Promise.resolve();
  assertEquals(f.rollback(), 0);
  held.resolve();
  await raw;
  await closed;
  assertEquals(f.rollback(), 1);
});
Deno.test("exclusive snapshot uncertain BEGIN quarantines the owned database", async () => {
  const f = fixture();
  f.setBeginError(new Error("BEGIN unknown"));
  await assertRejects(() => f.open(), Error, "BEGIN unknown");
  assertEquals(f.quarantine(), 1);
});
Deno.test("exclusive snapshot uncertain rollback quarantines and retains failure", async () => {
  const f = fixture();
  const reader = await f.open();
  f.setRollbackError(new Error("ROLLBACK unknown"));
  await assertRejects(() => reader.close(), Error, "ROLLBACK unknown");
  await assertRejects(() => reader.close(), Error, "ROLLBACK unknown");
  assertEquals(f.quarantine(), 1);
});
Deno.test("exclusive snapshot cancellation seals before raw drain and rollback", async () => {
  const f = fixture();
  const held = gate();
  f.setHook((sql) => sql === "SELECT held" ? held.promise : Promise.resolve());
  const abort = new AbortController();
  const reader = await f.open(abort.signal);
  const raw = reader.query("SELECT held");
  abort.abort();
  await assertRejects(() => reader.query("SELECT late"), Error, "closed");
  assertEquals(f.rollback(), 0);
  held.resolve();
  await raw;
  await reader.close();
  assertEquals(f.rollback(), 1);
});
Deno.test("actual native PGlite snapshot keeps outside writes queued until rollback", async () => {
  const db = new PGlite({
    startParams: [...lowMemoryPGliteStartParams],
    relaxedDurability: true,
  });
  let reader: Awaited<ReturnType<typeof openExclusiveReadSnapshot>> | undefined;
  let outside: Promise<unknown> | undefined;
  let quarantined = false;
  try {
    await db.exec(
      "CREATE TABLE probe(value integer); INSERT INTO probe VALUES(10)",
    );
    reader = await openExclusiveReadSnapshot(db, async () => {
      quarantined = true;
      await db.close();
    });
    assertEquals((await reader.query("SELECT value FROM probe")).rows, [{
      value: 10,
    }]);
    let done = false;
    outside = db.query("UPDATE probe SET value=20").then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assertEquals(done, false);
    assertEquals((await reader.query("SELECT value FROM probe")).rows, [{
      value: 10,
    }]);
    await reader.close();
    await outside;
    assertEquals(db.isInTransaction(), false);
    assertEquals((await db.query("SELECT value FROM probe")).rows, [{
      value: 20,
    }]);
  } finally {
    await reader?.close().catch(() => {});
    await outside?.catch(() => {});
    if (!quarantined) await db.close();
  }
});
Deno.test("exclusive snapshot requires literal false from native idle predicate", async () => {
  const f = fixture();
  const malformed = {
    ...f.provider,
    isInTransaction: () => undefined as unknown as boolean,
  };
  await assertRejects(
    () => openExclusiveReadSnapshot(malformed, () => Promise.resolve()),
    Error,
    "idle",
  );
  assertEquals(f.statements, []);
});
Deno.test("exclusive snapshot abort during SET waits for actual setup and rollback", async () => {
  const f = fixture();
  const entered = gate();
  const held = gate();
  f.setHook(() => {
    entered.resolve();
    return held.promise;
  });
  const controller = new AbortController();
  const opening = f.open(controller.signal);
  await entered.promise;
  const reason = new Error("cancel opening");
  controller.abort(reason);
  assertEquals(f.rollback(), 0);
  held.resolve();
  const error = await assertRejects(() => opening, Error, reason.message);
  assertEquals(error, reason);
  assertEquals(f.rollback(), 1);
  assertEquals(f.quarantine(), 0);
});
Deno.test("exclusive snapshot preserves setup failure when rollback also fails", async () => {
  const f = fixture();
  const setupError = new Error("setup failed");
  const rollbackError = new Error("rollback failed");
  f.setHook(() => Promise.reject(setupError));
  f.setRollbackError(rollbackError);
  const error = await assertRejects(() => f.open(), AggregateError);
  assertEquals(error.errors, [setupError, rollbackError]);
  assertEquals(f.quarantine(), 1);
});
Deno.test("actual PGlite existing manual transaction is preserved on refused snapshot", async () => {
  const db = new PGlite({
    startParams: [...lowMemoryPGliteStartParams],
    relaxedDurability: true,
  });
  try {
    await db.exec("CREATE TABLE probe(value integer)");
    await db.exec("SELECT 1; BEGIN");
    await db.query("INSERT INTO probe VALUES(42)");
    await assertRejects(
      () => openExclusiveReadSnapshot(db, () => db.close()),
      Error,
      "idle",
    );
    assertEquals(db.isInTransaction(), true);
    assertEquals((await db.query("SELECT value FROM probe")).rows, [{
      value: 42,
    }]);
    await db.query("COMMIT");
    assertEquals((await db.query("SELECT value FROM probe")).rows, [{
      value: 42,
    }]);
  } finally {
    await db.close();
  }
});
Deno.test("adapter certifies built-in native provider without a caller isolation flag", async () => {
  const { OminipgEngine } = await import("../src/worker/engine.ts");
  const { createPGliteProvider } = await import("../src/providers/pglite.ts");
  const engine = new OminipgEngine({ pgliteProvider: createPGliteProvider() });
  let reader: Awaited<ReturnType<typeof openExclusiveReadSnapshot>> | undefined;
  try {
    await engine.initialize({ url: ":memory:" });
    const provider = await engine.state.mainDb!.exclusiveSnapshotProvider!();
    reader = await openExclusiveReadSnapshot(provider, () => engine.close());
    assertEquals((await reader.query("SELECT 42 AS answer")).rows, [{
      answer: 42,
    }]);
  } finally {
    await reader?.close();
    await engine.close();
  }
});
Deno.test("adapter refuses unsupported effective config while ordinary queries remain usable", async () => {
  const { OminipgEngine } = await import("../src/worker/engine.ts");
  const { createPGliteProvider } = await import("../src/providers/pglite.ts");
  const engine = new OminipgEngine({ pgliteProvider: createPGliteProvider() });
  try {
    await engine.initialize({
      url: ":memory:",
      pgliteConfig: { extensions: {} },
    });
    await assertRejects(
      () => engine.state.mainDb!.exclusiveSnapshotProvider!(),
      Error,
      "configuration",
    );
    assertEquals(await engine.query("SELECT 42 AS answer"), [{ answer: 42 }]);
  } finally {
    await engine.close();
  }
});
Deno.test("adapter refuses a lookalike provider with the native descriptor", async () => {
  const { OminipgEngine } = await import("../src/worker/engine.ts");
  class Fake {
    query() {
      return Promise.resolve({ rows: [{ fake: true }] });
    }
    exec() {
      return Promise.resolve();
    }
    listen() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    isInTransaction() {
      return false;
    }
    transaction() {
      throw new Error("must not enter fake transaction");
    }
  }
  const engine = new OminipgEngine({
    pgliteProvider: {
      moduleSpecifier: "npm:@electric-sql/pglite@^0.4.5",
      loadPGlite: () => Promise.resolve({ PGlite: Fake }),
    },
  });
  try {
    await engine.initialize({ url: ":memory:" });
    await assertRejects(
      () => engine.state.mainDb!.exclusiveSnapshotProvider!(),
      Error,
      "native private",
    );
    assertEquals(await engine.query("SELECT anything"), [{ fake: true }]);
  } finally {
    await engine.close();
  }
});
