import { EventEmitter } from "node:events";
import { assertEquals, assertRejects } from "@std/assert";
import { AccountedPgPool } from "../src/worker/pool-capacity.ts";
import { PgListenerHub } from "../src/client/notifications.ts";
import type { PgPool, PgPoolClient } from "../src/shared/types.ts";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(max: number) {
  let active = 0;
  let peak = 0;
  let ended = 0;
  const queued: Array<(client: PgPoolClient) => void> = [];
  const log: string[] = [];
  let releaseFails = 0;
  function client(): PgPoolClient {
    active++;
    peak = Math.max(peak, active);
    let released = false;
    const value = {
      query(sql: string) {
        log.push(sql);
        return Promise.resolve({ rows: [] });
      },
      release(destroy = false) {
        if (releaseFails > 0) {
          releaseFails--;
          throw new Error("release fault");
        }
        if (released) throw new Error("double raw release");
        released = true;
        active--;
        log.push(destroy ? "discard" : "release");
        const next = queued.shift();
        if (next) next(client());
      },
      on() {
        return value;
      },
      removeListener() {
        return value;
      },
    };
    return value as unknown as PgPoolClient;
  }
  const raw: PgPool = {
    options: { max },
    connect: () =>
      active < max
        ? Promise.resolve(client())
        : new Promise((resolve) => queued.push(resolve)),
    end() {
      ended++;
      assertEquals(active, 0);
      return Promise.resolve();
    },
  };
  return {
    pool: new AccountedPgPool(raw, max),
    log,
    active: () => active,
    peak: () => peak,
    ended: () => ended,
    failRelease(count: number) {
      releaseFails = count;
    },
  };
}
Deno.test("retained LISTEN pin counts until actual hub close", async () => {
  const f = fixture(2);
  const hub = new PgListenerHub(f.pool, () => {});
  const sub = await hub.listen("capacity", () => {});
  const client = await f.pool.connect();
  let arrived = false;
  const pending = f.pool.connect().then((value) => {
    arrived = true;
    return value;
  });
  await sub.close();
  assertEquals(arrived, false);
  assertEquals(f.active(), 2);
  await hub.close();
  const next = await pending;
  client.release();
  next.release();
  await f.pool.end();
});
Deno.test("late normal checkout after close is returned instead of exposed", async () => {
  const late = gate();
  let releases = 0;
  let ended = 0;
  const raw: PgPool = {
    options: { max: 2 },
    async connect() {
      await late.promise;
      return Object.assign(new EventEmitter(), {
        release(destroy: boolean) {
          assertEquals(destroy, true);
          releases++;
        },
      }) as unknown as PgPoolClient;
    },
    end() {
      ended++;
      return Promise.resolve();
    },
  };
  const pool = new AccountedPgPool(raw, 2);
  const borrow = pool.connect();
  const refused = assertRejects(() => borrow, Error, "closed");
  const end = pool.end();
  assertEquals(ended, 0);
  late.resolve();
  await refused;
  await end;
  assertEquals(releases, 1);
});
Deno.test("normal double release preserves provider behavior without a double decrement", async () => {
  const f = fixture(2);
  const client = await f.pool.connect();
  client.release();
  let rejected = false;
  try {
    client.release();
  } catch {
    rejected = true;
  }
  assertEquals(rejected, true);
  await f.pool.end();
});

Deno.test("late failed return remains owned and end retries it before pool closure", async () => {
  const late = gate();
  let attempts = 0;
  let ended = 0;
  const raw: PgPool = {
    options: { max: 2 },
    async connect() {
      await late.promise;
      return Object.assign(new EventEmitter(), {
        release() {
          if (++attempts === 1) throw new Error("late return failed");
        },
      }) as unknown as PgPoolClient;
    },
    end() {
      ended++;
      return Promise.resolve();
    },
  };
  const pool = new AccountedPgPool(raw, 2);
  const borrow = pool.connect();
  const refused = assertRejects(() => borrow, Error, "late return failed");
  const end = pool.end();
  late.resolve();
  await refused;
  await end;
  assertEquals(attempts, 2);
  assertEquals(ended, 1);
});
Deno.test("old normal wrapper cannot release a newly checked-out reuse of the same client", async () => {
  let active = false;
  const client = Object.assign(new EventEmitter(), {
    release() {},
    query: () => Promise.resolve({ rows: [] }),
  }) as unknown as PgPoolClient;
  const raw: PgPool = {
    options: { max: 2 },
    connect() {
      assertEquals(active, false);
      active = true;
      let released = false;
      client.release = () => {
        if (released) throw new Error("double release");
        released = true;
        active = false;
      };
      return Promise.resolve(client);
    },
    end() {
      assertEquals(active, false);
      return Promise.resolve();
    },
  };
  const pool = new AccountedPgPool(raw, 2);
  const first = await pool.connect();
  assertEquals((client as unknown as EventEmitter).listenerCount("error"), 1);
  first.release();
  assertEquals((client as unknown as EventEmitter).listenerCount("error"), 0);
  const second = await pool.connect();
  assertEquals((client as unknown as EventEmitter).listenerCount("error"), 1);
  let failed = false;
  try {
    first.release();
  } catch {
    failed = true;
  }
  assertEquals(failed, true);
  assertEquals(active, true);
  second.release();
  await pool.end();
});

for (const failure of ["connect", "probe", "release"] as const) {
  Deno.test(`failed PostgreSQL initialization cleans unreturned pool after ${failure} failure`, async () => {
    const { OminipgEngine } = await import("../src/worker/engine.ts");
    let ended = 0;
    let released = 0;
    class Pool {
      connect() {
        if (failure === "connect") {
          return Promise.reject(new Error("connect fault"));
        }
        return Promise.resolve(Object.assign(new EventEmitter(), {
          query() {
            return failure === "probe"
              ? Promise.reject(new Error("probe fault"))
              : Promise.resolve({ rows: [] });
          },
          release() {
            released++;
            if (failure === "release" && released === 1) {
              throw new Error("release fault");
            }
          },
        }) as unknown as PgPoolClient);
      }
      end() {
        ended++;
        return Promise.resolve();
      }
    }
    const engine = new OminipgEngine({
      pgProvider: { loadPg: () => Promise.resolve({ Pool }) },
    });
    await assertRejects(
      () => engine.initialize({ url: "postgres://test/test" }),
      Error,
      `${failure} fault`,
    );
    assertEquals(ended, 1);
    assertEquals(
      released,
      failure === "connect" ? 0 : failure === "release" ? 2 : 1,
    );
    await engine.close();
    assertEquals(ended, 1);
  });
}
for (const synchronous of [false, true]) {
  Deno.test(`pool end retains physical shutdown failure without repeating it (sync=${synchronous})`, async () => {
    let ended = 0;
    const failure = new Error("physical shutdown unknown");
    const pool = new AccountedPgPool({
      connect: () => Promise.reject(new Error("unused")),
      end() {
        ended++;
        if (synchronous) throw failure;
        return Promise.reject(failure);
      },
    }, 2);
    const first = pool.end();
    assertEquals(pool.end(), first);
    await assertRejects(() => first, Error, failure.message);
    assertEquals(pool.end(), first);
    await assertRejects(() => pool.end(), Error, failure.message);
    assertEquals(ended, 1);
  });
}

Deno.test("pool end publishes its single promise before synchronous provider reentry", async () => {
  let calls = 0;
  let nested: Promise<void> | undefined;
  const pool: AccountedPgPool = new AccountedPgPool({
    connect: () => Promise.reject(new Error("unused")),
    end() {
      calls++;
      if (calls === 1) nested = pool.end();
      return Promise.resolve();
    },
  }, 2);
  const outer = pool.end();
  await outer;
  await nested;
  assertEquals(calls, 1);
  assertEquals(nested, outer);
});
function errorFixture(report: (error: Error) => void = () => {}) {
  const clients: Array<PgPoolClient & EventEmitter> = [];
  const destroys: boolean[] = [];
  let failReturn = false, failEnd = false, active = 0;
  const raw = Object.assign(new EventEmitter(), {
    options: { max: 2 },
    connect() {
      let returned = false;
      const client = Object.assign(new EventEmitter(), {
        query: (_sql: string) => Promise.resolve({ rows: [] }),
        release(destroy = false) {
          if (failReturn) {
            failReturn = false;
            throw new Error("return failed");
          }
          if (returned) throw new Error("double return");
          returned = true;
          active--;
          destroys.push(destroy);
        },
      });
      clients.push(client);
      active++;
      return Promise.resolve(client);
    },
    end() {
      if (failEnd) return Promise.reject(new Error("shutdown failed"));
      assertEquals(active, 0);
      return Promise.resolve();
    },
  });
  return {
    raw,
    clients,
    destroys,
    pool: new AccountedPgPool(raw, 2, report),
    active: () => active,
    failReturn() {
      failReturn = true;
    },
    failEnd() {
      failEnd = true;
    },
  };
}

Deno.test("pool owns borrowed and idle error events without returning capacity early", async () => {
  const errors: Error[] = [];
  const f = errorFixture((error) => {
    errors.push(error);
  });
  const client = await f.pool.connect();
  const fault = new Error("connection fault");
  f.clients[0].emit("error", fault);
  assertEquals(errors, [fault]);
  assertEquals(f.active(), 1);
  await assertRejects(() => client.query("COMMIT"), Error, "connection fault");
  assertEquals(f.active(), 1);
  client.release();
  assertEquals(f.destroys, [true]);
  assertEquals(f.clients[0].listenerCount("error"), 0);
  const idle = new Error("idle fault");
  f.raw.emit("error", idle);
  assertEquals(errors, [fault, idle]);
  const healthy = await f.pool.connect();
  await healthy.query("SELECT healthy");
  healthy.release();
  await f.pool.end();
  assertEquals(f.raw.listenerCount("error"), 0);
});

Deno.test("pool retains fault observation and charge after a failed client return", async () => {
  const errors: Error[] = [];
  const f = errorFixture((error) => {
    errors.push(error);
  });
  const client = await f.pool.connect();
  f.failReturn();
  let failure: unknown;
  try {
    client.release();
  } catch (error) {
    failure = error;
  }
  assertEquals((failure as Error).message, "return failed");
  assertEquals(f.active(), 1);
  assertEquals(f.clients[0].listenerCount("error"), 1);
  const fault = new Error("late fault");
  f.clients[0].emit("error", fault);
  await f.pool.end();
  assertEquals(errors, [fault]);
  assertEquals(f.destroys, [true]);
  assertEquals(f.clients[0].listenerCount("error"), 0);
});

Deno.test("pool fault observers cannot interrupt query refusal or cleanup", async () => {
  for (
    const report of [() => {
      throw new Error("observer threw");
    }, () => Promise.reject(new Error("observer rejected"))]
  ) {
    const f = errorFixture(report);
    const client = await f.pool.connect();
    f.clients[0].emit("error", new Error("transport fault"));
    await assertRejects(
      () => client.query("ROLLBACK"),
      Error,
      "transport fault",
    );
    client.release();
    await f.pool.end();
    assertEquals(f.destroys, [true]);
  }
});

Deno.test("pool keeps idle fault observation after unconfirmed shutdown", async () => {
  const errors: Error[] = [];
  const f = errorFixture((error) => {
    errors.push(error);
  });
  f.failEnd();
  await assertRejects(() => f.pool.end(), Error, "shutdown failed");
  const fault = new Error("late shutdown fault");
  f.raw.emit("error", fault);
  assertEquals(errors, [fault]);
  assertEquals(f.raw.listenerCount("error"), 1);
});

Deno.test("initial sync returns its remote client when local role reset fails", async () => {
  const { createEngineState } = await import("../src/worker/db.ts");
  const { performInitialSync } = await import("../src/worker/sync/initial.ts");
  const f = errorFixture();
  const state = createEngineState();
  state.syncPool = f.pool;
  state.mainDb = {
    query: () => Promise.resolve({ rows: [] }),
    exec: (sql) =>
      sql.includes("'origin'")
        ? Promise.reject(new Error("local reset failed"))
        : Promise.resolve(),
    close: () => Promise.resolve(),
  };
  await assertRejects(
    () => performInitialSync(state),
    Error,
    "local reset failed",
  );
  assertEquals(f.active(), 0);
  assertEquals(f.destroys, [false]);
  await f.pool.end();
});

for (const max of [1, 2, 4]) {
  Deno.test(`ordinary pool queues beyond capacity ${max} and drains before shutdown`, async () => {
    const f = fixture(max);
    assertEquals(f.pool.options?.max, max);
    const clients = await Promise.all(
      Array.from({ length: max }, () => f.pool.connect()),
    );
    let arrived = false;
    const pending = f.pool.connect().then((client) => {
      arrived = true;
      return client;
    });
    await Promise.resolve();
    assertEquals(arrived, false);
    clients[0].release();
    const next = await pending;
    const end = f.pool.end();
    assertEquals(f.ended(), 0);
    await assertRejects(() => f.pool.connect(), Error, "closed");
    for (const client of clients.slice(1)) client.release();
    next.release();
    await end;
    assertEquals(f.peak(), max);
    assertEquals(f.ended(), 1);
  });
}
Deno.test("pool end retries cleanup after transient ordinary return failure", async () => {
  const f = fixture(2);
  const client = await f.pool.connect();
  f.failRelease(2);
  try {
    client.release();
  } catch { /* Retain charge for retry. */ }
  await assertRejects(() => f.pool.end(), Error, "release fault");
  assertEquals(f.ended(), 0);
  client.release();
  await Promise.all([f.pool.end(), f.pool.end()]);
  assertEquals(f.active(), 0);
  assertEquals(f.ended(), 1);
});
