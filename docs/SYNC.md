# Sync guide

Ominipg synchronizes a local PGlite database with PostgreSQL. Local writes are
captured in an outbox and pushed to PostgreSQL; an initial pull and logical
replication apply remote changes back to PGlite.

Sync runs inside the same long-lived Oxian workload session as queries. Closing
the Ominipg client stops replication, timers, and database pools.

## Architecture

```mermaid
flowchart LR
  App["Application"] --> Client["Ominipg client"]
  Client --> Session["Oxian workload session"]
  Session --> Engine["OminipgEngine"]
  Engine --> Local["PGlite\nlocal database"]
  Engine --> Manager["Sync manager"]
  Local -->|"triggers → _outbox"| Manager
  Manager -->|"push batch"| Remote["PostgreSQL\nremote database"]
  Remote -->|"initial query + pgoutput WAL"| Manager
  Manager -->|"remote apply"| Local
```

The current implementation works in the PostgreSQL `public` schema and uses a
configured last-write-wins column, `updated_at` by default.

## Setup

```ts
import { Ominipg } from "jsr:@oxian/ominipg";
import { createPgProvider } from "jsr:@oxian/ominipg/pg";
import { createPGliteProvider } from "jsr:@oxian/ominipg/pglite";

const db = await Ominipg.connect({
  url: "file:///data/local.db",
  syncUrl: "postgresql://user:password@host/database",
  pgliteProvider: createPGliteProvider(),
  pgProvider: createPgProvider(),
  schemaSQL: [
    `CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  ],
});
```

`autoConfigure()` can inject both standard providers:

```ts
const db = await Ominipg.connect(autoConfigure({
  url: "file:///data/local.db",
  syncUrl: remoteUrl,
  schemaSQL,
}));
```

For a shared or remote Oxian dispatcher, configure provider callbacks where the
workload runs:

```ts
createOminipgWorkload({
  dependencies: {
    pgliteProvider: createPGliteProvider(),
    pgProvider: createPgProvider(),
  },
});
```

## Requirements

Each synchronized user table should:

- live in the `public` schema;
- have a primary key;
- have the LWW column on both databases;
- update the LWW column whenever a row changes;
- use column types supported by both PGlite and remote PostgreSQL.

The remote PostgreSQL role needs normal schema/data access plus permissions to
create or use logical-replication publications and slots. PostgreSQL must allow
logical replication with the `pgoutput` plugin. Managed services may require
provider-specific configuration.

`schemaSQL` is attempted on local and remote databases. Prefer idempotent DDL.
Ominipg can create missing local table/sequence definitions from remote catalog
metadata, but explicit application migrations remain the safer production schema
authority.

## Connection options

| Option            | Default      | Effect                                                            |
| ----------------- | ------------ | ----------------------------------------------------------------- |
| `syncUrl`         | none         | Enables the remote PostgreSQL pool and sync services              |
| `edgeId`          | random UUID  | Identifies this edge and names its publication/slot               |
| `lwwColumn`       | `updated_at` | Comparable column used by upsert conflict guards                  |
| `skipInitialSync` | `false`      | Skips the startup remote-to-local snapshot                        |
| `initialSyncFrom` | none         | Pulls only rows whose LWW value is at or after this ISO timestamp |
| `disableAutoPush` | `false`      | Disables outbox notification-triggered pushes                     |
| `pgPoolMax`       | `5`          | Size of PostgreSQL pools created by the engine                    |

Use a stable `edgeId` when the same logical edge reconnects. A new random value
creates a new publication/slot name.

## Startup sequence

When `syncUrl` is configured, engine initialization:

1. opens local PGlite and the remote PostgreSQL pool;
2. applies `schemaSQL` locally;
3. creates local `_sync_state`, `_outbox`, trigger function, and table triggers;
4. attempts `schemaSQL` remotely;
5. unless skipped, enumerates remote public tables, creates missing local table
   definitions, upserts remote rows, and synchronizes sequences;
6. ensures an edge publication and logical replication slot exist;
7. starts the `pgoutput` logical-replication subscription;
8. starts automatic outbox pushes unless disabled.

`Ominipg.connect()` resolves only after the replication service reports that it
started. Startup failures reject the connection and close partially initialized
resources.

## Local to remote

PGlite triggers record `INSERT`, `UPDATE`, and `DELETE` operations in `_outbox`.
They also emit an internal `outbox_new` notification. Automatic push reacts to
that signal; explicit push is always available:

```ts
const { pushed } = await db.sync();
console.log(`Pushed ${pushed} outbox entries`);
```

A push reads entries after `_sync_state.last_push`, applies them in one remote
transaction, commits, advances the local cursor, and deletes committed outbox
rows. Updates use `ON CONFLICT ... DO UPDATE` only when the incoming LWW value
is newer than the remote value.

Set `disableAutoPush: true` when the application wants to control batching:

```ts
const db = await Ominipg.connect({
  ...options,
  disableAutoPush: true,
});

await db.transaction(async (tx) => {
  for (const todo of todos) {
    await tx.query(
      "INSERT INTO todos(id, title) VALUES ($1, $2)",
      [todo.id, todo.title],
    );
  }
});
await db.sync();
```

The `sync:start` and `sync:end` client events surround explicit `db.sync()`
calls. Automatic pushes run inside the workload and do not emit those client
events.

## Remote to local

### Initial pull

The initial pull reads existing remote rows table by table. It filters internal
tables whose names begin with `_`, creates missing local table definitions,
upserts rows using the LWW guard, and synchronizes sequence values.

`initialSyncFrom` adds `WHERE <lwwColumn> >= $1` to each table query. Ensure
every included table has that column. `skipInitialSync` is useful when restoring
a known-current local snapshot.

### Continuous pull

The logical replication service consumes `insert`, `update`, and `delete`
messages from a per-edge `pgoutput` publication/slot. Remote writes are applied
inside local transactions with a session flag that suppresses the local outbox
trigger.

If a replicated table is missing locally, Ominipg reads its remote column,
default, sequence, and primary-key metadata, creates it, attaches the outbox
trigger, and retries the change.

## Echo prevention and conflicts

Ominipg uses two related mechanisms:

- it attempts to tag remote pushes with a PostgreSQL replication origin equal to
  `edgeId`;
- it tracks recently pushed primary keys and suppresses equivalent or older WAL
  echoes when origin support is unavailable or insufficient.

Insert/update upserts compare `lwwColumn` and keep the row with the greater
value. This is last-write-wins, not semantic field merging. Deletes are applied
by primary key and do not retain a tombstone/LWW value.

Applications should generate trustworthy, consistently ordered LWW values—
normally database timestamps—and understand clock-skew consequences. Complex
collaborative conflict resolution belongs above the current sync layer.

## Sequences

Initial sync updates local sequences. They can also be synchronized explicitly:

```ts
const { synced } = await db.syncSequences();
```

This enumerates local public user tables, finds remote sequences associated with
their columns, and advances local values based on local maxima. UUID or other
edge-safe identifiers are often simpler for multi-edge applications.

## Error handling

```ts
db.on("error", (error) => {
  reportDatabaseError(error);
});

try {
  await db.sync();
} catch (error) {
  queueRetry(error);
}
```

Explicit push failures reject `sync()` and leave the outbox cursor unchanged so
the batch can be retried. Replication-service errors are logged by the workload;
applications should monitor process logs and database slot health in addition to
client events.

## Operational limits

- Sync currently targets all eligible `public` tables; there is no table filter.
- Schema migration is best-effort and not a replacement for a migration system.
- Initial sync loads rows table by table without pagination.
- Outbox push reads the pending set as one batch; very large queues should be
  controlled operationally.
- Deletes have no LWW tombstone conflict strategy.
- Publication and slot lifecycle needs operational cleanup when edge IDs are
  retired.
- Logical replication privileges and behavior vary across managed PostgreSQL
  products.
- Multiple local sessions with different random edge IDs create independent
  remote replication resources.
- PGlite memory and the remote replication client count toward the workload
  runtime's resource limits.

## Shutdown

Always close the client:

```ts
await db.close();
```

The session stops its logical replication service, clears timers, closes local
PGlite and remote pools, and then completes the Oxian operation. An injected
host or Hypervisor remains owned by the embedding application.

## Related documentation

- [Architecture](./ARCHITECTURE.md)
- [Oxian embedding and routing](./OXIAN.md)
- [Runtime support](./RUNTIMES.md)
- [PGlite memory characteristics](./PGLITE.md)
