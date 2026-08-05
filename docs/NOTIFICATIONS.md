# PostgreSQL notifications

Ominipg exposes connection-scoped `LISTEN`/`NOTIFY` through its Oxian workload
session. The main database must be PostgreSQL.

```ts
import { Ominipg } from "jsr:@oxian/ominipg";
import { createPgProvider } from "jsr:@oxian/ominipg/pg";

const databaseUrl = getDatabaseUrlForThisRuntime();
const db = await Ominipg.connect({
  url: databaseUrl,
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

The same API works when the workload is on a private embedded host, a shared
host, or a worker routed through an Oxian Hypervisor. Notifications arrive as
asynchronous `ominipg.session.v1` event frames.

## Lifecycle

- One listener connection is checked out lazily per Ominipg engine session.
- Channels and handlers are multiplexed and reference-counted on that
  connection.
- A connection failure changes active subscriptions to `reconnecting`, reports
  the error, reconnects with capped exponential backoff, and reissues active
  `LISTEN` statements.
- `subscription.closed` resolves after explicit shutdown or `db.close()`.
- `onStateChange` and `onError` expose listener lifecycle without allowing one
  callback failure to interrupt another subscription.
- A handler exception is reported to the subscription and Ominipg `error`
  listeners; it does not interrupt other handlers.
- `db.close()` closes subscriptions and the listener hub before ending the query
  pool.

The listener pins one pool connection. `pgPoolMax` therefore must be at least 2
when calling `listen()`; the default is 5.

```ts
subscription.onStateChange((state) => {
  // connecting | connected | reconnecting | closed
  console.log(state);
});

subscription.onError((error) => {
  console.error("listener error", error);
});

await subscription.closed;
```

## Delivery and correctness

PostgreSQL notifications are wake-up signals, not durable queue entries. Store
authoritative state in tables and perform a recovery query on startup,
reconnect, and periodically. Notification payloads should contain identifiers,
not command output or large data.

Channels use a deliberately strict identifier grammar:
`^[A-Za-z_][A-Za-z0-9_]{0,62}$`. Payloads are passed through parameterized
`pg_notify`.

PGlite rejects `listen()` and `notify()`. A routed session also requires the
worker runtime to own a compatible `pgProvider`; provider callbacks do not cross
the Ominipg stream.
