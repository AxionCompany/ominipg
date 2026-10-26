import { assertEquals, assertRejects } from "@std/assert";
import {
  createEngineState,
  initConnections,
  requireMainDb,
} from "../src/worker/db.ts";
import type { PgModule, PgPoolClient } from "../src/shared/types.ts";

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
          () => reject(new Error("Shutdown progress deadline")),
          200,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(max = Infinity) {
  let active = 0;
  const waiting: Array<() => void> = [];
  let ended = 0;
  let begin: (() => Promise<void>) | undefined;
  const clients: Array<
    {
      queries: string[];
      returns: boolean[];
      released: boolean;
      fail: number;
      release(destroy?: boolean): void;
    }
  > = [];
  class Pool {
    async connect() {
      if (active >= max) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      active++;
      const client = {
        queries: [] as string[],
        returns: [] as boolean[],
        released: false,
        fail: 0,
        async query(sql: string) {
          this.queries.push(sql);
          if (sql.startsWith("BEGIN")) await begin?.();
          return { rows: [] };
        },
        release(destroy = false) {
          this.returns.push(destroy);
          if (this.fail > 0) {
            this.fail--;
            throw new Error("injected return failure");
          }
          if (this.released) throw new Error("duplicate return");
          this.released = true;
          active--;
          waiting.shift()?.();
        },
        on() {
          return this;
        },
        removeListener() {
          return this;
        },
      };
      clients.push(client);
      return Promise.resolve(client as unknown as PgPoolClient);
    }
    end() {
      ended++;
      assertEquals(clients.every((c) => c.released), true);
      return Promise.resolve();
    }
  }
  const state = createEngineState({
    pgProvider: { loadPg: () => Promise.resolve({ Pool } as PgModule) },
  });
  await initConnections(state, { url: "postgres://test/test" });
  return {
    db: requireMainDb(state),
    pool: state.mainPool!,
    clients,
    ended: () => ended,
    holdBegin(hook: () => Promise<void>) {
      begin = hook;
    },
  };
}
for (const deferred of [false, true]) {
  Deno.test(`shutdown drains an admitted ${deferred ? "first batch" : "BEGIN"} before collecting transaction pins`, async () => {
    const f = await fixture(), entered = gate(), release = gate();
    f.holdBegin(async () => {
      entered.resolve();
      await release.promise;
    });
    const opening = deferred
      ? f.db.query("SELECT first", [], "late", {})
      : f.db.query("BEGIN", [], "late");
    await entered.promise;
    const closing = f.db.close();
    void closing.catch(() => {});
    release.resolve();
    try {
      await opening;
      await deadline(closing);
      assertEquals(f.clients.at(-1)!.queries, [
        deferred ? "BEGIN;\nSELECT first" : "BEGIN",
        "ROLLBACK",
      ]);
      assertEquals(f.clients.at(-1)!.returns, [false]);
      assertEquals(f.ended(), 1);
      await assertRejects(
        () => f.db.query("BEGIN", [], "after"),
        Error,
        "closed",
      );
    } finally {
      for (const client of f.clients) {
        if (!client.released) client.release(true);
      }
    }
  });
}

Deno.test("shutdown visits every pin and pool end after a throwing client return", async () => {
  const f = await fixture();
  await f.db.query("BEGIN", [], "first");
  await f.db.query("BEGIN", [], "second");
  f.clients[1].fail = 1;
  try {
    const error = await assertRejects(() => deadline(f.db.close()));
    assertEquals(f.clients[2].queries, ["BEGIN", "ROLLBACK"]);
    assertEquals(f.clients[2].released, true);
    assertEquals(f.clients[1].returns, [false, true]);
    assertEquals(f.ended(), 1);
    assertEquals(error instanceof AggregateError, true);
  } finally {
    for (const client of f.clients) if (!client.released) client.release(true);
  }
});

Deno.test("shutdown returns late opens without deadlocking behind existing pins", async () => {
  const f = await fixture(1);
  await f.db.query("BEGIN", [], "existing");
  const first = f.db.query("BEGIN", [], "queued-first");
  const second = f.db.query("BEGIN", [], "queued-second");
  const closing = f.db.close();
  void closing.catch(() => {});
  try {
    await deadline(Promise.all([Promise.allSettled([first, second]), closing]));
    assertEquals(f.clients.length, 4);
    assertEquals(f.clients.every((client) => client.released), true);
    assertEquals(f.ended(), 1);
  } finally {
    // Release the intentionally broken baseline's original pin and late pins.
    for (let step = 0; step < 20; step++) {
      for (const client of f.clients) {
        if (!client.released) client.release(true);
      }
      await Promise.resolve();
    }
  }
});

Deno.test("shutdown drains an admitted COMMIT before collecting its former pin", async () => {
  const f = await fixture(), entered = gate(), release = gate();
  await f.db.query("BEGIN", [], "committing");
  const client = f.clients.at(-1)!;
  // The provider fixture's last checked-out client is the managed transaction.
  const raw = client as typeof client & {
    query(sql: string): Promise<{ rows: unknown[] }>;
  };
  const query = raw.query.bind(raw);
  raw.query = async (sql) => {
    if (sql === "COMMIT") {
      entered.resolve();
      await release.promise;
    }
    return await query(sql);
  };
  const committing = f.db.query("COMMIT", [], "committing");
  await entered.promise;
  const closing = f.db.close();
  void closing.catch(() => {});
  release.resolve();
  await deadline(Promise.all([committing, closing]));
  assertEquals(client.queries, ["BEGIN", "COMMIT"]);
  assertEquals(client.returns, [false]);
  assertEquals(f.ended(), 1);
});

Deno.test("shutdown retries a failed pin return before draining a queued BEGIN", async () => {
  const f = await fixture(1);
  await f.db.query("BEGIN", [], "existing");
  f.clients.at(-1)!.fail = 1;
  const opening = f.db.query("BEGIN", [], "queued");
  const opened = opening.catch(() => {});
  const closing = f.db.close();
  const observed = closing.catch((error) => error);
  try {
    const error = await deadline(observed);
    await deadline(opened);
    assertEquals(error instanceof AggregateError, true);
    assertEquals(f.clients.every((client) => client.released), true);
    assertEquals(f.ended(), 1);
  } finally {
    for (let step = 0; step < 20; step++) {
      for (const client of f.clients) {
        if (!client.released) client.release(true);
      }
      await Promise.resolve();
    }
  }
});

Deno.test("shutdown reports unconfirmed returns without waiting on blocked opens", async () => {
  const f = await fixture(1);
  await f.db.query("BEGIN", [], "existing");
  const pin = f.clients.at(-1)!;
  pin.fail = 2;
  const opening = f.db.query("BEGIN", [], "queued");
  const opened = opening.catch(() => {});
  try {
    await assertRejects(
      () => deadline(f.db.close()),
      AggregateError,
      "cleanup failed",
    );
    assertEquals(f.ended(), 0);
    assertEquals(pin.returns, [false, true]);
  } finally {
    pin.fail = 0;
    await deadline(f.pool.end());
    await deadline(opened);
  }
  assertEquals(f.ended(), 1);
  assertEquals(f.clients.every((client) => client.released), true);
});
