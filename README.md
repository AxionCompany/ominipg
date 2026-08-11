<div align="center">
  <img src="./assets/logo_color.png" alt="Ominipg Logo" width="200">

# Ominipg

> Runtime-neutral PostgreSQL and PGlite sessions powered by Oxian workloads

[![JSR](https://jsr.io/badges/@oxian/ominipg)](https://jsr.io/@oxian/ominipg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

Ominipg combines PGlite, PostgreSQL, local-first sync, typed CRUD helpers, and
Drizzle integration behind one session API. Every connection is now an
`ominipg.session.v1` Oxian workload, whether it runs inside an application or
behind an Oxian Hypervisor.

The default is lightweight and embedded: Ominipg creates a private Oxian
Hypervisor and an in-process Worker in the current JavaScript isolate. It uses
Web Streams and does not open a WebSocket or create a Web Worker/thread.
Applications can instead inject a shared Hypervisor or another Oxian-compatible
dispatcher.

## Highlights

- Runtime-neutral core built from standard JavaScript and Web APIs
- Deno/JSR and ESM-only npm packages for Node.js 22+ and Bun
- Cloudflare Worker/browser-compatible client, session, and workload boundary
- Private embedded, shared embedded, and Hypervisor-routed execution topologies
- Independent engine state for every session, including connections and sync
- PGlite in-memory and persistent databases
- Direct PostgreSQL, `LISTEN`/`NOTIFY`, and pinned transactions
- Local-first PGlite-to-PostgreSQL synchronization
- Type-safe CRUD helpers and Drizzle proxy integration
- Raw binary session attachments for snapshots and byte-valued rows
- Optional database providers: the core does not eagerly load PGlite or `pg`

An embedded worker is a lifecycle and ownership boundary, not an isolation
boundary. CPU-heavy database work still runs on the same event loop. Use a
remote Oxian worker/process when memory, crash, security, or CPU isolation is
required.

## Installation

### Deno

```ts
import { Ominipg } from "jsr:@oxian/ominipg";
import { autoConfigure } from "jsr:@oxian/ominipg/auto";
import { createPGliteProvider } from "jsr:@oxian/ominipg/pglite";
import { createPgProvider } from "jsr:@oxian/ominipg/pg";
```

### Node.js and Bun

```sh
npm install @oxian/ominipg
```

```ts
import { Ominipg } from "@oxian/ominipg";
import { autoConfigure } from "@oxian/ominipg/auto";
import { createPGliteProvider } from "@oxian/ominipg/pglite";
import { createPgProvider } from "@oxian/ominipg/pg";
```

Install only the optional engines used by the application:

```sh
npm install @electric-sql/pglite
npm install pg pg-logical-replication
```

## Quick start

`autoConfigure()` selects provider descriptors from `url` and `syncUrl`:

```ts
const db = await Ominipg.connect(autoConfigure({
  url: ":memory:",
  schemaSQL: [
    `CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )`,
  ],
}));

await db.query("INSERT INTO users(id, name) VALUES ($1, $2)", ["1", "Ada"]);
const { rows } = await db.query("SELECT * FROM users");

await db.close();
```

Or supply explicit providers:

```ts
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
});
```

### Transaction

The callback stays on one long-lived workload session. PostgreSQL transactions
pin a pool client until commit or rollback.

```ts
const user = await db.transaction(async (tx) => {
  const { rows } = await tx.query<{ id: string }>(
    "INSERT INTO users(id, name) VALUES ($1, $2) RETURNING id",
    [crypto.randomUUID(), "Grace"],
  );
  await tx.query("INSERT INTO audit(user_id, action) VALUES ($1, $2)", [
    rows[0].id,
    "created",
  ]);
  return rows[0];
});
```

Queries and other database operations submitted concurrently on the same
`Ominipg` instance wait until the transaction callback settles. Use the `tx`
argument for every query that belongs to the transaction.

### Local-first sync

```ts
const db = await Ominipg.connect({
  url: "file:///data/app.db",
  syncUrl: remoteDatabaseUrl,
  pgliteProvider: createPGliteProvider(),
  pgProvider: createPgProvider(),
  schemaSQL,
});

await db.query("INSERT INTO todos(id, title) VALUES ($1, $2)", [id, title]);
const { pushed } = await db.sync();
```

### Typed CRUD

```ts
import { defineSchema, Ominipg } from "jsr:@oxian/ominipg";

const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["id", "name"],
    },
    keys: [{ property: "id" }],
  },
});

const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
  schemas,
});

await db.crud.users.create({ id: "1", name: "Ada", age: 36 });
const adults = await db.crud.users.find({ age: { $gte: 18 } });
```

### Drizzle

```ts
import { Ominipg, withDrizzle } from "jsr:@oxian/ominipg";
import { drizzle } from "npm:drizzle-orm/pg-proxy";

const ominipg = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
});
const db = await withDrizzle(ominipg, drizzle, { users });
const allUsers = await db.select().from(users);
```

## Execution topologies

Database choice and execution topology are independent:

| Database      | `url`                                  | Typical use                                             |
| ------------- | -------------------------------------- | ------------------------------------------------------- |
| PGlite memory | `:memory:`                             | Tests and ephemeral state                               |
| PGlite file   | `file://...`                           | Local/offline persistence where the runtime supports it |
| PostgreSQL    | `postgres://...` or `postgresql://...` | Server database and notifications                       |

| Topology          | Configuration                                | Transport and ownership                                                      |
| ----------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| Private embedded  | Omit `oxian`                                 | One private Hypervisor/Worker per connection; closed by `db.close()`         |
| Shared embedded   | Pass `{ oxian: { dispatcher: hypervisor } }` | Same isolate and event loop; application owns the topology                   |
| Hypervisor-routed | Pass a Hypervisor or compatible dispatcher   | Workload may execute in another process/runtime; dispatcher owner manages it |

All three use the same framed byte-stream session and Oxian lifecycle. The
embedded path avoids sockets, TLS, kernel scheduling, and network I/O while
still exercising admission, handshake, readiness, credit, and cancellation.

### Shared in-process topology

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.21.0-rc.2/hypervisor";
import { createWorker } from "jsr:@oxian/oxian-js@0.21.0-rc.2/worker";
import {
  createOminipgWorkload,
  Ominipg,
  OMINIPG_SESSION_WORKLOAD,
} from "jsr:@oxian/ominipg";
import { createPGliteProvider } from "jsr:@oxian/ominipg/pglite";

const local = {
  type: "in-process",
  config: { topic: "application-databases" },
} as const;
const hypervisor = createHypervisor({ transports: [local] });
const worker = createWorker({
  id: "application-databases",
  transport: local,
  capacity: 8,
  workloads: {
    [OMINIPG_SESSION_WORKLOAD]: createOminipgWorkload({
      dependencies: { pgliteProvider: createPGliteProvider() },
    }),
  },
});
await worker.ready;

const db = await Ominipg.connect({
  url: ":memory:",
  oxian: { dispatcher: hypervisor },
});

await db.close(); // closes only this engine session
await worker.stop();
await worker.closed;
await hypervisor.shutdown();
```

For a remotely attached workload, configure providers in
`createOminipgWorkload({ dependencies })` or `resolveDependencies(metadata)`.
Provider callbacks are process-local and cannot cross a session stream.
Descriptor-only configuration can cross the stream, but a workload should own
runtime-specific module selection when client and worker runtimes differ.

## Runtime support

| Surface                  | Deno               | Node 22+           | Bun                | Cloudflare Worker/browser      |
| ------------------------ | ------------------ | ------------------ | ------------------ | ------------------------------ |
| Client/session protocol  | Supported          | npm + CI           | npm + CI           | Web-API-compatible bundle      |
| Embedded Worker          | Supported          | Verified           | Verified in CI     | Same-isolate execution         |
| Ominipg workload         | Supported          | Verified           | Verified in CI     | Provider-dependent             |
| PGlite                   | Provider-dependent | Optional peer      | Optional peer      | Provider/platform limits apply |
| `pg`/logical replication | Provider-dependent | Optional peers     | Package-dependent  | No generic built-in adapter    |
| `file://` PGlite         | Runtime filesystem | Supported provider | Provider-dependent | Not available in an isolate    |

Runtime-neutral means the Ominipg core does not import Deno APIs, Node builtins,
Bun APIs, Cloudflare bindings, Web Workers, or `worker_threads`. Database engine
support still depends on a provider that works in the chosen runtime. See
[Runtime support](./docs/RUNTIMES.md).

## API at a glance

```ts
await db.query(sql, params);
await db.transaction(async (tx) => value);

await db.sync();
await db.syncSequences();

const subscription = await db.listen("jobs_ready", handler);
await db.notify("jobs_ready", "job-id");
await subscription.close();

const snapshot = await db.dumpDataDir();
const diagnostics = await db.getDiagnosticInfo();
await db.close();
```

PostgreSQL notifications are wake-up signals, not a durable queue. One listener
connection is shared by each engine session, and `listen()` requires
`pgPoolMax >= 2`.

## Connection options

```ts
await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://...",
  schemaSQL: ["CREATE TABLE ..."],
  edgeId: crypto.randomUUID(),
  lwwColumn: "updated_at",
  initialSyncFrom: "2026-01-01T00:00:00.000Z",
  skipInitialSync: false,
  disableAutoPush: false,

  pgliteProvider: createPGliteProvider(),
  pgProvider: createPgProvider(),
  pgliteExtensions: ["uuid_ossp", "vector"],
  pgliteMemoryProfile: "low-memory",
  pgliteConfig: {},
  pgPoolMax: 5,

  oxian: {
    dispatcher,
    workload: OMINIPG_SESSION_WORKLOAD,
    metadata: { tenantId },
    target: { workerId },
    signal,
    deadlineAtMs,
    maxFrameBytes: 512 * 1024 * 1024,
  },
  runtime: { getRssMb: optionalHostMemoryProbe },
  schemas,
  logMetrics: false,
});
```

`useWorker` remains accepted as a deprecated no-op for source migration. It no
longer chooses a direct, Web Worker, or `worker_threads` path.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md)
- [Oxian embedding and routing](./docs/OXIAN.md)
- [Runtime support](./docs/RUNTIMES.md)
- [Migrating to 0.9](./docs/MIGRATION_0_9.md)
- [API reference](./docs/API.md)
- [Quick reference](./docs/QUICK_REFERENCE.md)
- [CRUD guide](./docs/CRUD.md)
- [Drizzle integration](./docs/DRIZZLE.md)
- [Sync guide](./docs/SYNC.md)
- [PostgreSQL notifications](./docs/NOTIFICATIONS.md)
- [PGlite memory characteristics](./docs/PGLITE.md)
- [Extensions](./docs/EXTENSIONS.md)
- [Historical 0.6 migration](./docs/MIGRATION_0_6.md)

## Development

```sh
deno task check
deno task test:deno
deno task test:npm-node
deno task check:publish
deno task verify
```

The verification workflow covers Deno, Node 22/24, Bun, and a browser-platform
bundle suitable for Cloudflare Worker code. PostgreSQL integration tests require
their documented environment variables.

## License

MIT License. See [LICENSE](./LICENSE).

Ominipg builds on [Oxian](https://jsr.io/@oxian/oxian-js),
[PGlite](https://pglite.dev/), [node-postgres](https://node-postgres.com/), and
[Drizzle ORM](https://orm.drizzle.team/).
