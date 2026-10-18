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
  let queryHook: ((sql: string) => Promise<void>) | undefined;
  let releaseFails = 0;
  function client(): PgPoolClient {
    active++;
    peak = Math.max(peak, active);
    let released = false;
    const value = {
      async query(sql: string) {
        log.push(sql);
        await queryHook?.(sql);
        return { rows: [] };
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
    queryHook(value: typeof queryHook) {
      queryHook = value;
    },
    failRelease(count: number) {
      releaseFails = count;
    },
  };
}
Deno.test("pool accounting retains ordinary queueing and refuses unavailable pair before checkout", async () => {
  const f = fixture(2);
  const a = await f.pool.connect();
  const b = await f.pool.connect();
  const pending = f.pool.connect();
  let arrived = false;
  void pending.then(() => {
    arrived = true;
  });
  await assertRejects(
    () => f.pool.reservePair(),
    Error,
    "capacity is unavailable",
  );
  assertEquals(arrived, false);
  a.release();
  const c = await pending;
  b.release();
  c.release();
  await f.pool.end();
  assertEquals(f.peak(), 2);
  assertEquals(f.ended(), 1);
});
Deno.test("pair reserves within existing total and resets before capacity returns", async () => {
  const f = fixture(4);
  const a = await f.pool.connect();
  const pair = await f.pool.reservePair();
  const b = await f.pool.connect();
  const pending = f.pool.connect();
  await assertRejects(
    () => f.pool.reservePair(),
    Error,
    "capacity is unavailable",
  );
  await pair.clients[0].query("SELECT snapshot");
  await pair.clients[1].query("SELECT current");
  await pair.release();
  const c = await pending;
  await assertRejects(
    () => pair.clients[0].query("SELECT stale"),
    Error,
    "closed",
  );
  assertEquals(f.log.filter((x) => x === "ROLLBACK").length, 2);
  a.release();
  b.release();
  c.release();
  await pair.release();
  await f.pool.end();
  assertEquals(f.peak(), 4);
});
Deno.test("pool of one still supports ordinary usage and refuses pair", async () => {
  const f = fixture(1);
  await assertRejects(
    () => f.pool.reservePair(),
    Error,
    "capacity is unavailable",
  );
  assertEquals(f.active(), 0);
  const c = await f.pool.connect();
  c.release();
  await f.pool.end();
});
Deno.test("retained LISTEN pin counts until actual hub close", async () => {
  const f = fixture(2);
  const hub = new PgListenerHub(f.pool, () => {});
  const sub = await hub.listen("capacity", () => {});
  await assertRejects(
    () => f.pool.reservePair(),
    Error,
    "capacity is unavailable",
  );
  await sub.close();
  await assertRejects(
    () => f.pool.reservePair(),
    Error,
    "capacity is unavailable",
  );
  await hub.close();
  const pair = await f.pool.reservePair();
  await pair.release();
  await f.pool.end();
});
Deno.test("pair release and pool end retain actual in-flight SQL until drain", async () => {
  const f = fixture(2);
  const held = gate();
  const started = gate();
  f.queryHook(async (sql) => {
    if (sql === "SELECT held") {
      started.resolve();
      await held.promise;
    }
  });
  const pair = await f.pool.reservePair();
  const read = pair.clients[0].query("SELECT held");
  await started.promise;
  let released = false;
  const release = pair.release().then(() => {
    released = true;
  });
  const end = f.pool.end();
  await assertRejects(
    () => pair.clients[1].query("SELECT late"),
    Error,
    "closed",
  );
  assertEquals(released, false);
  assertEquals(f.ended(), 0);
  assertEquals(f.active(), 2);
  held.resolve();
  await read;
  await release;
  await end;
  assertEquals(f.active(), 0);
});
Deno.test("failed pair release keeps its charge and retries only unreleased clients", async () => {
  const f = fixture(2);
  const pair = await f.pool.reservePair();
  f.failRelease(1);
  await assertRejects(() => pair.release(), Error, "release fault");
  await assertRejects(
    () => f.pool.reservePair(),
    Error,
    "capacity is unavailable",
  );
  assertEquals(f.active(), 1);
  await pair.release();
  assertEquals(f.active(), 0);
  assertEquals(f.log.filter((x) => x === "ROLLBACK").length, 2);
  await f.pool.end();
});
Deno.test("failed reset discards only the affected client", async () => {
  const f = fixture(2);
  const pair = await f.pool.reservePair();
  let resets = 0;
  f.queryHook((sql) =>
    sql === "ROLLBACK" && ++resets === 1
      ? Promise.reject(new Error("reset failed"))
      : Promise.resolve()
  );
  await pair.release();
  assertEquals(f.log.filter((x) => x === "discard").length, 1);
  await f.pool.end();
});

Deno.test("partial pair failure waits for late acquisition and releases it", async () => {
  const late = gate();
  let calls = 0;
  let releases = 0;
  let ended = 0;
  const raw: PgPool = {
    options: { max: 2 },
    async connect() {
      if (++calls === 1) throw undefined;
      await late.promise;
      return Object.assign(new EventEmitter(), {
        query: () => Promise.resolve({ rows: [] }),
        release() {
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
  let rejected = false;
  let settled = false;
  const reservation = pool.reservePair().then(() => {
    settled = true;
  }, () => {
    rejected = true;
    settled = true;
  });
  await assertRejects(
    () => pool.reservePair(),
    Error,
    "capacity is unavailable",
  );
  assertEquals(settled, false);
  const ending = pool.end();
  assertEquals(ended, 0);
  late.resolve();
  await reservation;
  await ending;
  assertEquals(rejected, true);
  assertEquals(releases, 1);
  assertEquals(ended, 1);
});
Deno.test("abort during pair acquisition retains charge until both raw clients return", async () => {
  const late = gate();
  let releases = 0;
  const controller = new AbortController();
  const raw: PgPool = {
    options: { max: 2 },
    async connect() {
      await late.promise;
      return Object.assign(new EventEmitter(), {
        query: () => Promise.resolve({ rows: [] }),
        release() {
          releases++;
        },
      }) as unknown as PgPoolClient;
    },
    end() {
      return Promise.resolve();
    },
  };
  const pool = new AccountedPgPool(raw, 2);
  const pending = pool.reservePair(controller.signal);
  const refused = assertRejects(() => pending, Error, "cancelled");
  controller.abort(new Error("cancelled"));
  await assertRejects(
    () => pool.reservePair(),
    Error,
    "capacity is unavailable",
  );
  assertEquals(releases, 0);
  late.resolve();
  await refused;
  assertEquals(releases, 2);
  await pool.end();
});
Deno.test("close seals and drains an active pair without a caller release", async () => {
  const f = fixture(2);
  const pair = await f.pool.reservePair();
  await pair.clients[0].query("BEGIN");
  await f.pool.end();
  await assertRejects(
    () => pair.clients[0].query("SELECT late"),
    Error,
    "closed",
  );
  assertEquals(f.active(), 0);
  assertEquals(f.ended(), 1);
  await pair.release();
});
Deno.test("end wakes acquisition admission waiters and rejects a late normal borrow", async () => {
  const late = gate();
  let releases = 0;
  let calls = 0;
  let ended = 0;
  const raw: PgPool = {
    options: { max: 2 },
    async connect() {
      calls++;
      await late.promise;
      return Object.assign(new EventEmitter(), {
        query: () => Promise.resolve({ rows: [] }),
        release() {
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
  const pair = pool.reservePair();
  const rejectedPair = assertRejects(() => pair, Error, "closed");
  const borrow = pool.connect();
  const rejectedBorrow = assertRejects(() => borrow, Error, "closed");
  const end = pool.end();
  await rejectedBorrow;
  assertEquals(calls, 2);
  assertEquals(ended, 0);
  late.resolve();
  await rejectedPair;
  await end;
  assertEquals(releases, 2);
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
  const pair = await f.pool.reservePair();
  await pair.release();
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
const pgUrl = Deno.env.get("DB_URL_PG");
Deno.test({
  name:
    "real PostgreSQL pair shares accounted main pool with LISTEN and ordinary SQL",
  ignore: !pgUrl,
  async fn() {
    const { OminipgEngine } = await import("../src/worker/engine.ts");
    const { createPgProvider } = await import("../src/providers/pg.ts");
    const engine = new OminipgEngine({ pgProvider: createPgProvider() });
    await engine.initialize({ url: pgUrl!, pgPoolMax: 3 });
    const pool = engine.state.mainPool as AccountedPgPool;
    assertEquals(pool instanceof AccountedPgPool, true);
    let pair: Awaited<ReturnType<typeof pool.reservePair>> | undefined;
    let query: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await engine.listen("capacity", "pair_capacity", { onNotification() {} });
      pair = await pool.reservePair();
      const first =
        (await pair.clients[0].query("SELECT pg_backend_pid() AS pid"))
          .rows[0] as { pid: number };
      const second =
        (await pair.clients[1].query("SELECT pg_backend_pid() AS pid"))
          .rows[0] as { pid: number };
      assertEquals(first.pid === second.pid, false);
      await pair.clients[0].query(
        "BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ",
      );
      let done = false;
      query = engine.query("SELECT 1").then((value) => {
        done = true;
        return value;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assertEquals(done, false);
      await pair.release();
      await query;
      assertEquals(done, true);
      pair = await pool.reservePair();
      const ended = await Promise.race([
        engine.close().then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      assertEquals(
        ended,
        true,
        "engine close must release its own reserved pair",
      );
      await assertRejects(
        () => pair!.clients[0].query("SELECT stale"),
        Error,
        "closed",
      );
    } finally {
      clearTimeout(timer);
      await pair?.release();
      await query?.catch(() => {});
      await engine.close();
    }
  },
});

for (const kind of ["pair", "normal"] as const) {
  Deno.test(`pool end retries pre-shutdown cleanup after transient ${kind} return failure`, async () => {
    const f = fixture(2);
    const pair = kind === "pair" ? await f.pool.reservePair() : undefined;
    const normal = kind === "normal" ? await f.pool.connect() : undefined;
    f.failRelease(kind === "normal" ? 2 : 1);
    if (normal) {
      try {
        normal.release();
      } catch { /* Retain charge for retry. */ }
    }
    await assertRejects(() => f.pool.end(), Error, "release fault");
    assertEquals(f.ended(), 0);
    if (pair) await pair.release();
    else normal!.release();
    assertEquals(f.active(), 0);
    await Promise.all([f.pool.end(), f.pool.end()]);
    await f.pool.end();
    assertEquals(f.ended(), 1);
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
Deno.test("pool end seals pair query admission synchronously before deferred cleanup", async () => {
  const f = fixture(2);
  const pair = await f.pool.reservePair();
  const held = gate();
  f.queryHook((sql) =>
    sql === "SELECT held" ? held.promise : Promise.resolve()
  );
  const admitted = pair.clients[0].query("SELECT held");
  const close = f.pool.end();
  await assertRejects(
    () => pair.clients[1].query("SELECT late"),
    Error,
    "closed",
  );
  assertEquals(f.log.includes("SELECT late"), false);
  assertEquals(f.ended(), 0);
  held.resolve();
  await admitted;
  await close;
  assertEquals(f.ended(), 1);
});

function errorFixture(report: (error: Error) => void = () => {}) {
  const clients: Array<PgPoolClient & EventEmitter> = [];
  const destroys: boolean[] = [];
  const second = gate();
  let holdSecond = false, failReturn = false, failEnd = false, active = 0;
  const raw = Object.assign(new EventEmitter(), {
    options: { max: 2 },
    async connect() {
      const number = clients.length;
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
      if (holdSecond && number === 1) await second.promise;
      return client;
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
    holdSecond() {
      holdSecond = true;
    },
    releaseSecond: second.resolve,
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

Deno.test("pool owns first pair client while the second checkout remains pending", async () => {
  const errors: Error[] = [];
  const f = errorFixture((error) => {
    errors.push(error);
  });
  f.holdSecond();
  const pending = f.pool.reservePair();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(f.clients.length, 2);
  assertEquals(f.clients[0].listenerCount("error"), 1);
  const fault = new Error("first pair fault");
  f.clients[0].emit("error", fault);
  assertEquals(errors, [fault]);
  assertEquals(f.active(), 2);
  f.releaseSecond();
  const pair = await pending;
  await assertRejects(
    () => pair.clients[0].query("SELECT snapshot"),
    Error,
    "first pair fault",
  );
  await pair.release();
  assertEquals(f.destroys, [true, false]);
  await f.pool.end();
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

Deno.test("pair reset faults discard clients and failed returns retain their observers", async () => {
  const errors: Error[] = [];
  const f = errorFixture((error) => {
    errors.push(error);
  });
  const pair = await f.pool.reservePair();
  const fault = new Error("reset transport fault");
  f.clients[0].query = () => {
    f.clients[0].emit("error", fault);
    return Promise.resolve({ rows: [] });
  };
  f.failReturn();
  await assertRejects(() => pair.release(), Error, "return failed");
  assertEquals(f.active(), 1);
  assertEquals(f.clients[0].listenerCount("error"), 1);
  await f.pool.end();
  assertEquals(f.destroys, [false, true]);
  assertEquals(errors, [fault]);
  assertEquals(f.clients[0].listenerCount("error"), 0);
});
