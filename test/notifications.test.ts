import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { Ominipg } from "../src/client/index.ts";
import type {
  PgModule,
  PgNotificationMessage,
  PgPool,
  PgPoolClient,
} from "../src/shared/types.ts";

type Listener = (...args: unknown[]) => void;

class FakeClient {
  readonly queries: Array<{ sql: string; params?: unknown[] }> = [];
  readonly listeners = new Map<string, Set<Listener>>();
  released = false;
  destroyed = false;

  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push({ sql, params });
    return { rows: sql === "SELECT 1" ? [{ "?column?": 1 }] : [] };
  }

  release(destroy = false): void {
    this.released = true;
    this.destroyed = destroy;
  }

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  notify(message: PgNotificationMessage): void {
    this.emit("notification", message);
  }
}

class FakePool implements PgPool {
  static latest?: FakePool;
  readonly clients: FakeClient[] = [];
  readonly options: { connectionString?: string; max?: number };
  ended = false;

  constructor(options: { connectionString: string; max?: number }) {
    this.options = options;
    FakePool.latest = this;
  }

  async connect(): Promise<PgPoolClient> {
    const client = new FakeClient();
    this.clients.push(client);
    return client as unknown as PgPoolClient;
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  listenerClient(): FakeClient {
    const client = this.clients.find((entry) =>
      entry.queries.some(({ sql }) => sql.startsWith("LISTEN ")) &&
      !entry.destroyed
    );
    if (!client) throw new Error("No active listener client.");
    return client;
  }
}

const provider = {
  loadPg: async (): Promise<PgModule> => ({
    Pool: FakePool as unknown as PgModule["Pool"],
  }),
};

const delay = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

Deno.test("direct notifications multiplex, isolate callbacks, notify, and clean up", async () => {
  const db = await Ominipg.connect({
    url: "postgresql://test/test",
    useWorker: false,
    pgProvider: provider,
    pgPoolMax: 4,
  });
  const pool = FakePool.latest!;
  const received: string[] = [];
  const errors: Error[] = [];
  db.on("error", (error) => errors.push(error));

  const first = await db.listen("sandbox_command_00", ({ payload }) => {
    received.push(`first:${payload}`);
  });
  const failing = await db.listen("sandbox_command_00", () => {
    throw new Error("callback failed");
  });
  const afterFailure = await db.listen("sandbox_command_00", ({ payload }) => {
    received.push(`after:${payload}`);
  });
  const second = await db.listen("sandbox_result_00", ({ payload }) => {
    received.push(`second:${payload}`);
  });

  const listener = pool.listenerClient();
  assertEquals(
    listener.queries.filter(({ sql }) => sql.startsWith("LISTEN ")).length,
    2,
  );
  listener.notify({
    channel: "sandbox_command_00",
    payload: "command-1",
    processId: 42,
  });
  listener.notify({
    channel: "sandbox_result_00",
    payload: "result-1",
    processId: 42,
  });

  assertEquals(received, [
    "first:command-1",
    "after:command-1",
    "second:result-1",
  ]);
  assertEquals(errors.map((error) => error.message), ["callback failed"]);

  await db.notify("sandbox_command_00", "command-2");
  const notifyQuery = pool.clients.flatMap((client) => client.queries).find(
    ({ sql }) => sql === "SELECT pg_notify($1, $2)",
  );
  assertEquals(notifyQuery?.params, ["sandbox_command_00", "command-2"]);

  await first.close();
  assertEquals(
    listener.queries.some(({ sql }) => sql === 'UNLISTEN "sandbox_command_00"'),
    false,
  );
  await failing.close();
  assertEquals(
    listener.queries.some(({ sql }) => sql === 'UNLISTEN "sandbox_command_00"'),
    false,
  );
  await afterFailure.close();
  assertEquals(
    listener.queries.some(({ sql }) => sql === 'UNLISTEN "sandbox_command_00"'),
    true,
  );

  await db.close();
  await Promise.all([
    first.closed,
    failing.closed,
    afterFailure.closed,
    second.closed,
  ]);
  assertEquals(second.state, "closed");
  assertEquals(pool.ended, true);
  assertEquals(
    listener.queries.some(({ sql }) => sql === "UNLISTEN *"),
    true,
  );
});

Deno.test("listener reconnects and reissues active LISTEN channels", async () => {
  const db = await Ominipg.connect({
    url: "postgresql://test/test",
    useWorker: false,
    pgProvider: provider,
  });
  const pool = FakePool.latest!;
  const received: string[] = [];
  const states: string[] = [];
  db.on("error", () => {});
  const subscription = await db.listen("events", ({ payload }) => {
    received.push(payload ?? "");
  });
  subscription.onStateChange((state) => states.push(state));

  const original = pool.listenerClient();
  original.emit("error", new Error("connection reset"));
  await delay(250);

  const replacement = pool.listenerClient();
  assertEquals(replacement === original, false);
  assertEquals(original.destroyed, true);
  assertEquals(
    replacement.queries.some(({ sql }) => sql === 'LISTEN "events"'),
    true,
  );
  replacement.notify({ channel: "events", payload: "ok", processId: 9 });
  assertEquals(received, ["ok"]);
  assertEquals(states, ["reconnecting", "connected"]);

  await db.close();
});

Deno.test("notification APIs reject unsafe channels and undersized pools", async () => {
  const db = await Ominipg.connect({
    url: "postgresql://test/test",
    useWorker: false,
    pgProvider: provider,
    pgPoolMax: 1,
  });
  db.on("error", () => {});

  await assertRejects(
    () => db.listen("events; DROP TABLE users", () => {}),
    Error,
    "notification channels must match",
  );
  await assertRejects(
    () => db.notify("bad-channel", "payload"),
    Error,
    "notification channels must match",
  );
  await assertRejects(
    () => db.listen("events", () => {}),
    Error,
    "pgPoolMax >= 2",
  );

  try {
    await Ominipg.connect({
      url: "postgresql://test/test",
      useWorker: false,
      pgProvider: provider,
      pgPoolMax: 0,
    });
    throw new Error("Expected invalid pool size to fail.");
  } catch (error) {
    assertStringIncludes(String(error), "pgPoolMax must be a positive integer");
  }

  await db.close();
});
