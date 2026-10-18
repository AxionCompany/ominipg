import { assertEquals, assertRejects } from "@std/assert";
import { Ominipg, type OminipgTransaction } from "../src/client/index.ts";
import { createPGliteProvider } from "../src/providers/pglite.ts";
import { createPgProvider } from "../src/providers/pg.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Snapshot callback progress deadline")),
          4000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function create() {
  return Ominipg.connect({
    url: ":memory:",
    pgliteProvider: createPGliteProvider(),
  });
}
Deno.test("native client snapshot returns local computation and seals retained reads", async () => {
  const db = await create();
  let retained: OminipgTransaction | undefined;
  try {
    const answer = await db.withReadSnapshot(async (scope) => {
      assertEquals(scope.kind, "exclusive");
      retained = scope.snapshot;
      const { rows } = await scope.snapshot.query<{ value: number }>(
        "SELECT 42 AS value",
      );
      await assertRejects(
        () => db.withReadSnapshot(() => 0),
        Error,
        "already active",
      );
      return rows[0].value + 1;
    });
    assertEquals(answer, 43);
    await assertRejects(() => retained!.query("SELECT 1"), Error, "closed");
    assertEquals((await db.query("SELECT 44 AS value")).rows, [{ value: 44 }]);
  } finally {
    await db.close();
  }
});
Deno.test("native snapshot callback failure preserves error and ordinary database use", async () => {
  const db = await create();
  const failure = new Error("callback failed");
  try {
    const error = await assertRejects(
      () =>
        db.withReadSnapshot(async ({ snapshot }) => {
          await snapshot.query("SELECT 1");
          throw failure;
        }),
      Error,
      failure.message,
    );
    assertEquals(error, failure);
    assertEquals((await db.query("SELECT 42 AS value")).rows, [{ value: 42 }]);
  } finally {
    await db.close();
  }
});
Deno.test("ordinary native query waits behind callback snapshot without entering its transaction", async () => {
  const db = await create();
  const entered = gate(), release = gate();
  let work: Promise<unknown> | undefined,
    ordinary: Promise<unknown> | undefined;
  try {
    work = db.withReadSnapshot(async ({ snapshot }) => {
      await snapshot.query("SELECT 1");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let done = false;
    ordinary = db.query("SELECT 42 AS value").then((r) => {
      done = true;
      return r;
    });
    await Promise.resolve();
    assertEquals(done, false);
    release.resolve();
    await work;
    assertEquals(await ordinary, { rows: [{ value: 42 }] });
  } finally {
    release.resolve();
    await work?.catch(() => {});
    await ordinary?.catch(() => {});
    await db.close();
  }
});
Deno.test("snapshot abort releases native resource without waiting local callback computation", async () => {
  const db = await create();
  const entered = gate(), release = gate();
  const controller = new AbortController();
  const reason = new Error("cancel snapshot");
  let retained: OminipgTransaction | undefined;
  const work = db.withReadSnapshot(async ({ snapshot }) => {
    retained = snapshot;
    await snapshot.query("SELECT 1");
    entered.resolve();
    await release.promise;
    return 42;
  }, { signal: controller.signal });
  const observed = assertRejects(() => work, Error, reason.message);
  try {
    await entered.promise;
    controller.abort(reason);
    assertEquals(await deadline(observed), reason);
    await assertRejects(() => retained!.query("SELECT 1"), Error, "closed");
    assertEquals((await db.query("SELECT 43 AS value")).rows, [{ value: 43 }]);
  } finally {
    release.resolve();
    await work.catch(() => {});
    await db.close();
  }
});
Deno.test("database close aborts a held snapshot callback before its exclusive queue drain", async () => {
  const db = await create();
  const entered = gate(), release = gate();
  const work = db.withReadSnapshot(async ({ snapshot }) => {
    await snapshot.query("SELECT 1");
    entered.resolve();
    await release.promise;
  });
  const observed = assertRejects(() => work, Error, "closed");
  let closing: Promise<void> | undefined;
  try {
    await entered.promise;
    closing = db.close();
    await deadline(observed);
    await deadline(closing);
  } finally {
    release.resolve();
    await work.catch(() => {});
    await closing?.catch(() => {});
    await db.close();
  }
});
const pgUrl = Deno.env.get("DB_URL_PG");
Deno.test({
  name:
    "pooled callback snapshot serializes current transactions and keeps historical values",
  ignore: !pgUrl,
  async fn() {
    const db = await Ominipg.connect({
      url: pgUrl!,
      pgPoolMax: 2,
      pgProvider: createPgProvider(),
    });
    let outside: Promise<unknown> | undefined;
    let retained: OminipgTransaction | undefined;
    try {
      await db.query("CREATE TABLE client_snapshot_probe(value integer)");
      await db.query("INSERT INTO client_snapshot_probe VALUES(10)");
      const result = await db.withReadSnapshot(async (scope) => {
        if (scope.kind !== "pooled") throw new Error("Expected pooled scope");
        assertEquals(
          (await scope.snapshot.query(
            "SELECT value FROM client_snapshot_probe",
          )).rows,
          [{ value: 10 }],
        );
        outside = db.query("SELECT 42 AS value");
        const values = await Promise.all([
          scope.current(async (tx) => {
            retained = tx;
            await tx.query("UPDATE client_snapshot_probe SET value=value+1");
            return 1;
          }),
          scope.current(async (tx) => {
            await tx.query("UPDATE client_snapshot_probe SET value=value+1");
            return 2;
          }),
        ]);
        assertEquals(values, [1, 2]);
        await assertRejects(() => retained!.query("SELECT 1"), Error, "closed");
        assertEquals(
          (await scope.snapshot.query(
            "SELECT value FROM client_snapshot_probe",
          )).rows,
          [{ value: 10 }],
        );
        return 42;
      });
      assertEquals(result, 42);
      assertEquals(await outside, { rows: [{ value: 42 }] });
      assertEquals(
        (await db.query("SELECT value FROM client_snapshot_probe")).rows,
        [{ value: 12 }],
      );
      await db.query("DROP TABLE client_snapshot_probe");
    } finally {
      await outside?.catch(() => {});
      await db.close();
    }
  },
});
Deno.test({
  name:
    "snapshot abort rolls back an admitted current transaction before returning its connection",
  ignore: !pgUrl,
  async fn() {
    const db = await Ominipg.connect({
      url: pgUrl!,
      pgPoolMax: 2,
      pgProvider: createPgProvider(),
    });
    const entered = gate(),
      release = gate(),
      controller = new AbortController();
    let work: Promise<unknown> | undefined;
    try {
      await db.query("CREATE TABLE client_snapshot_abort_probe(value integer)");
      await db.query("INSERT INTO client_snapshot_abort_probe VALUES(10)");
      work = db.withReadSnapshot(async (scope) => {
        if (scope.kind !== "pooled") throw new Error("Expected pooled scope");
        await scope.current(async (tx) => {
          await tx.query("UPDATE client_snapshot_abort_probe SET value=20");
          entered.resolve();
          await release.promise;
        });
      }, { signal: controller.signal });
      const observed = assertRejects(() => work!, Error, "abort current");
      await entered.promise;
      controller.abort(new Error("abort current"));
      await deadline(observed);
      assertEquals(
        (await db.query("SELECT value FROM client_snapshot_abort_probe")).rows,
        [{ value: 10 }],
      );
      await db.query("DROP TABLE client_snapshot_abort_probe");
    } finally {
      release.resolve();
      await work?.catch(() => {});
      await db.close();
    }
  },
});
async function pooledFixture(
  hook: (sql: string) => Promise<void> = () => Promise.resolve(),
  releaseHook: () => void = () => {},
) {
  type Client = import("../src/shared/types.ts").PgPoolClient;
  class Pool {
    connect() {
      const value = {
        async query(sql: string) {
          await hook(sql);
          return { rows: [{ value: 42 }] };
        },
        release() {
          releaseHook();
        },
        on: () => value,
        removeListener: () => value,
      };
      return Promise.resolve(value as Client);
    }
    end() {
      return Promise.resolve();
    }
  }
  return await Ominipg.connect({
    url: "postgres://fixture/fixture",
    pgPoolMax: 2,
    pgProvider: { loadPg: () => Promise.resolve({ Pool }) },
  });
}
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
for (const phase of ["query", "commit"] as const) {
  Deno.test(`aborted current ${phase} cannot disclose a retained late result`, async () => {
    const held = gate(), entered = gate(), controller = new AbortController();
    const reason = new Error("scope revoked");
    const db = await pooledFixture(async (sql) => {
      if (sql === (phase === "query" ? "SELECT held" : "COMMIT")) {
        entered.resolve();
        await held.promise;
      }
    });
    let inner:
      | Promise<{ ok: boolean; value?: unknown; error?: unknown }>
      | undefined;
    let current: Promise<unknown> | undefined;
    const work = outcome(db.withReadSnapshot(async (scope) => {
      if (scope.kind !== "pooled") throw new Error("Expected pooled scope");
      current = scope.current(async (tx) => {
        if (phase === "query") {
          inner = outcome(tx.query("SELECT held"));
          await inner;
        }
        return 42;
      });
      await current;
    }, { signal: controller.signal }));
    try {
      await entered.promise;
      controller.abort(reason);
      held.resolve();
      assertEquals((await work).ok, false);
      assertEquals(
        (phase === "query" ? await inner! : await outcome(current!)).ok,
        false,
      );
    } finally {
      held.resolve();
      await work;
      await db.close();
    }
  });
}
Deno.test("snapshot options capture one signal and retain its original abort reason", async () => {
  const entered = gate(),
    release = gate(),
    first = new AbortController(),
    other = new AbortController();
  const db = await pooledFixture();
  const options = { signal: first.signal };
  const reason = new Error("original signal");
  const work = outcome(db.withReadSnapshot(async () => {
    entered.resolve();
    await release.promise;
    return 42;
  }, options));
  try {
    await entered.promise;
    options.signal = other.signal;
    first.abort(reason);
    assertEquals(await work, { ok: false, error: reason });
    assertEquals(await db.withReadSnapshot(() => 43), 43);
  } finally {
    release.resolve();
    await work;
    await db.close();
  }
});
Deno.test("signal getter is read once and cannot strand subsequent snapshot admission", async () => {
  const db = await pooledFixture();
  const controller = new AbortController();
  let reads = 0;
  const options = {
    get signal() {
      if (++reads > 1) throw new Error("repeated getter");
      return controller.signal;
    },
  };
  try {
    assertEquals(await db.withReadSnapshot(() => 42, options), 42);
    assertEquals(reads, 1);
    assertEquals(await db.withReadSnapshot(() => 43), 43);
  } finally {
    await db.close();
  }
});
Deno.test("throwing listener registration or removal cannot latch snapshot admission", async () => {
  const db = await pooledFixture();
  try {
    for (const method of ["addEventListener", "removeEventListener"] as const) {
      const controller = new AbortController();
      const original = controller.signal[method].bind(controller.signal);
      Object.defineProperty(controller.signal, method, {
        value() {
          throw new Error("listener failed");
        },
        configurable: true,
      });
      await assertRejects(
        () => db.withReadSnapshot(() => 42, { signal: controller.signal }),
        Error,
        "listener failed",
      );
      Object.defineProperty(controller.signal, method, {
        value: original,
        configurable: true,
      });
      assertEquals(await db.withReadSnapshot(() => 43), 43);
    }
  } finally {
    await db.close();
  }
});
Deno.test("reentrant signal getter cannot overwrite an inner snapshot's close controller", async () => {
  const db = await create();
  const entered = gate(), release = gate(), controller = new AbortController();
  let inner: Promise<unknown> | undefined;
  let observedInner: Promise<unknown> | undefined;
  const options = {
    get signal() {
      inner = db.withReadSnapshot(async () => {
        entered.resolve();
        await release.promise;
        return 42;
      });
      observedInner = outcome(inner);
      return controller.signal;
    },
  };
  let closing: Promise<void> | undefined;
  try {
    await assertRejects(
      () => db.withReadSnapshot(() => 43, options),
      Error,
      "already active",
    );
    await entered.promise;
    closing = db.close();
    await deadline(closing);
    assertEquals((await observedInner as { ok: boolean }).ok, false);
  } finally {
    release.resolve();
    await inner?.catch(() => {});
    await closing?.catch(() => {});
    await db.close();
  }
});
Deno.test("getter-triggered database close prevents a later snapshot claim", async () => {
  const db = await pooledFixture();
  const controller = new AbortController();
  let closing: Promise<void> | undefined;
  const options = {
    get signal() {
      closing = db.close();
      return controller.signal;
    },
  };
  try {
    await assertRejects(
      () => db.withReadSnapshot(() => 42, options),
      Error,
      "closed",
    );
    await closing;
  } finally {
    await db.close();
  }
});

Deno.test("snapshot cleanup observation is separate from value and callback failure", async () => {
  const db = await create();
  const reports: string[] = [];
  const failure = new Error("callback rejected");
  try {
    assertEquals(
      await db.withReadSnapshot(() => 42, {
        onCleanup: (value) => {
          reports.push(value);
        },
      }),
      42,
    );
    assertEquals(
      await assertRejects(() =>
        db.withReadSnapshot(() => {
          throw failure;
        }, {
          onCleanup: (value) => {
            reports.push(value);
          },
        })
      ),
      failure,
    );
    assertEquals(reports, ["confirmed", "confirmed"]);
    assertEquals(
      await db.withReadSnapshot(() => 43, {
        onCleanup() {
          throw new Error("observer failed");
        },
      }),
      43,
    );
  } finally {
    await db.close();
  }
});

Deno.test("capacity refusal reports confirmed cleanup and permits later admission", async () => {
  const db = await pooledFixture();
  const entered = gate(), release = gate();
  const reports: string[] = [];
  const ordinary = db.transaction(async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    await assertRejects(() =>
      db.withReadSnapshot(() => 42, {
        onCleanup: (value) => {
          reports.push(value);
        },
      })
    );
    assertEquals(reports, ["confirmed"]);
    release.resolve();
    await ordinary;
    assertEquals(
      await db.withReadSnapshot(() => 43, {
        onCleanup: (value) => {
          reports.push(value);
        },
      }),
      43,
    );
    assertEquals(reports, ["confirmed", "confirmed"]);
  } finally {
    release.resolve();
    await ordinary.catch(() => {});
    await db.close();
  }
});

for (const phase of ["query", "rollback"] as const) {
  Deno.test(`cleanup observation waits for actual ${phase} drain`, async () => {
    const entered = gate(),
      release = gate(),
      controller = new AbortController();
    const reports: string[] = [];
    const reason = new Error("cancelled held query");
    const db = await pooledFixture(async (sql) => {
      if (sql === (phase === "query" ? "SELECT held" : "ROLLBACK")) {
        entered.resolve();
        await release.promise;
      }
    });
    const work = outcome(db.withReadSnapshot(async (scope) => {
      await scope.snapshot.query(
        phase === "query" ? "SELECT held" : "SELECT 42",
      );
      return 42;
    }, {
      signal: controller.signal,
      onCleanup: (value) => {
        reports.push(value);
      },
    }));
    try {
      await entered.promise;
      if (phase === "query") controller.abort(reason);
      await new Promise((done) => setTimeout(done, 10));
      assertEquals(reports, []);
      release.resolve();
      const result = await work;
      assertEquals(result.ok, phase === "rollback");
      if (!result.ok) assertEquals(result.error, reason);
      assertEquals(reports, ["confirmed"]);
    } finally {
      release.resolve();
      await work;
      await db.close();
    }
  });
}

Deno.test("failed reset with confirmed discard still reports confirmed cleanup", async () => {
  const reports: string[] = [];
  const db = await pooledFixture((sql) =>
    sql === "ROLLBACK"
      ? Promise.reject(new Error("rollback fault"))
      : Promise.resolve()
  );
  try {
    assertEquals(
      await db.withReadSnapshot(() => 42, {
        onCleanup: (value) => {
          reports.push(value);
        },
      }),
      42,
    );
    assertEquals(reports, ["confirmed"]);
  } finally {
    await db.close().catch(() => {});
  }
});

Deno.test("cleanup observer can cancel returned value without changing physical outcome", async () => {
  const db = await create(), controller = new AbortController();
  const reason = new Error("cancelled after cleanup");
  const reports: string[] = [];
  try {
    assertEquals(
      await assertRejects(() =>
        db.withReadSnapshot(() => 42, {
          signal: controller.signal,
          onCleanup(value) {
            reports.push(value);
            controller.abort(reason);
          },
        })
      ),
      reason,
    );
    assertEquals(reports, ["confirmed"]);
    assertEquals(await db.withReadSnapshot(() => 43), 43);
  } finally {
    await db.close();
  }
});

Deno.test("unconfirmed client return reports unknown even when callback succeeded", async () => {
  const reports: string[] = [];
  let fail = false;
  const db = await pooledFixture(undefined, () => {
    if (fail) throw new Error("return fault");
  });
  try {
    fail = true;
    await assertRejects(() =>
      db.withReadSnapshot(() => 42, {
        onCleanup(value) {
          reports.push(value);
        },
      })
    );
    assertEquals(reports, ["unknown"]);
  } finally {
    await db.close().catch(() => {});
  }
});
