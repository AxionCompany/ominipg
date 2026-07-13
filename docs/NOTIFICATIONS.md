# PostgreSQL notifications

OminiPG exposes connection-scoped `LISTEN`/`NOTIFY` support in direct PostgreSQL
mode.

```ts
import { Ominipg } from "jsr:@oxian/ominipg";
import { createPgProvider } from "jsr:@oxian/ominipg/pg";

const db = await Ominipg.connect({
  url: Deno.env.get("DATABASE_URL")!,
  useWorker: false,
  pgProvider: createPgProvider(),
  pgPoolMax: 5,
});

const subscription = await db.listen("sandbox_command_00", (notification) => {
  console.log(notification.channel, notification.payload);
});

await db.notify("sandbox_command_00", "command-id");
await subscription.close();
await db.close();
```

## Lifecycle

- One listener connection is checked out lazily per OminiPG instance.
- Channels and handlers are multiplexed and reference-counted on that
  connection.
- A connection failure changes active subscriptions to `reconnecting`, reports
  the error, reconnects with capped exponential backoff, and reissues active
  `LISTEN` statements.
- `subscription.closed` resolves after explicit subscription shutdown or
  `db.close()`.
- `onStateChange` and `onError` expose listener lifecycle without allowing one
  callback failure to interrupt another subscription.
- `db.close()` shuts down the listener hub before ending the query pool.

The listener pins one pool connection. `pgPoolMax` therefore must be at least 2
when calling `listen()`; the default is 5.

## Delivery and correctness

PostgreSQL notifications are wake-up signals, not durable queue entries. Store
authoritative state in tables and perform a recovery query on startup,
reconnect, and periodically. Notification payloads should contain identifiers,
not command output or large data.

Channels use a deliberately strict identifier grammar:
`^[A-Za-z_][A-Za-z0-9_]{0,62}$`. Notification payloads are passed through the
parameterized `pg_notify` function.

The initial release supports direct PostgreSQL mode only. Worker, PGlite, and
sync modes reject `listen()` and `notify()`.
