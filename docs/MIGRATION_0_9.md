# Migrating to Ominipg 0.9

Ominipg 0.9 replaces the inline engine, Deno Web Worker, and Node
`worker_threads` paths with one Oxian-native workload session. It also makes the
public execution core runtime-neutral.

## What changed

| Before 0.9                                                       | 0.9                                            |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| Inline engine or runtime-specific worker selected per connection | Every connection is `ominipg.session.v1`       |
| `useWorker` selected direct versus worker execution              | Deprecated no-op                               |
| Deno Web Worker and Node `worker_threads` implementations        | Portable Oxian Worker/workload                 |
| Module-global worker database state                              | One explicit `EngineState` per session         |
| Worker `postMessage` request/response protocol                   | Bidirectional Web Streams with Ominipg framing |
| Database callbacks passed to an inline engine                    | Private capture or workload-owned dependencies |
| Closing a worker/direct client followed separate paths           | One session close lifecycle                    |

The public query, CRUD, Drizzle, sync, diagnostics, snapshot, notification, and
event APIs remain available. Existing code that only calls `Ominipg.connect()`
usually needs no source change.

## Default behavior

```ts
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
});
```

This now creates a private Oxian Hypervisor, one in-process Worker, and one
workload session. It does not create a listener, WebSocket, Web Worker, or
worker thread. `db.close()` shuts down all resources owned by that private
session.

The in-process Worker runs on the caller's JavaScript event loop. If the old
worker mode was used for CPU, memory, crash, or security isolation, move the
Ominipg workload to an Oxian worker in another process/isolate; the default does
not retain that isolation.

## Remove `useWorker`

Before:

```ts
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider,
  useWorker: true,
});
```

After:

```ts
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider,
});
```

`useWorker: true` and `useWorker: false` are accepted temporarily as equivalent
deprecated no-ops. Remove the field so code does not imply thread isolation or a
direct bypass that no longer exists.

## Replace custom worker entrypoints

Do not import or spawn `src/worker/index.ts` as a worker script. The `./worker`
subpath is now a side-effect-free compatibility export for the workload factory.
Prefer `./workload`:

```ts
import {
  createOminipgWorkload,
  OMINIPG_SESSION_WORKLOAD,
} from "jsr:@oxian/ominipg/workload";
```

Place it on an in-process Oxian Worker:

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.21.0-rc.2/hypervisor";
import { createWorker } from "jsr:@oxian/oxian-js@0.21.0-rc.2/worker";

const local = {
  type: "in-process",
  config: { topic: "database-worker" },
} as const;
const hypervisor = createHypervisor({ transports: [local] });
const worker = createWorker({
  id: "database-worker",
  transport: local,
  workloads: {
    [OMINIPG_SESSION_WORKLOAD]: createOminipgWorkload({
      dependencies: { pgliteProvider, pgProvider },
    }),
  },
  capacity: 4,
});
await worker.ready;

const db = await Ominipg.connect({
  url,
  oxian: { dispatcher: hypervisor },
});
```

The application owns `worker` and `hypervisor`. Closing `db` closes only its
engine session. On application shutdown, call `worker.stop()`, await
`worker.closed`, and then call `hypervisor.shutdown()`.

## Provider migration

### Private embedded

Existing callback providers continue to work because Ominipg captures them in
the private workload:

```ts
await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: {
    loadPGlite: () => import("./my-pglite.ts"),
  },
});
```

### Shared or remote dispatcher

Functions cannot cross the byte stream. Configure providers where the workload
runs:

```ts
createOminipgWorkload({
  dependencies: {
    pgliteProvider: createPGliteProvider(),
    pgProvider: createPgProvider(),
  },
});
```

Client-supplied providers contribute only module specifier descriptors. This is
convenient when client and worker share a runtime, but the worker should own
module selection when runtimes differ.

`pgliteConfig` stays process-local for private sessions. With an external
dispatcher it crosses the session and must contain only wire-encodable values.

## Runtime imports

### Deno

```ts
import { Ominipg } from "jsr:@oxian/ominipg";
import { autoConfigure } from "jsr:@oxian/ominipg/auto";
```

### Node.js 22+ or Bun

```ts
import { Ominipg } from "@oxian/ominipg";
import { autoConfigure } from "@oxian/ominipg/auto";
```

The npm package is ESM-only. Install the optional database peers used by the
workload. Runtime-global branching is no longer needed in application code.

## Transactions

Prefer the new callback helper:

```ts
await db.transaction(async (tx) => {
  await tx.query("INSERT INTO accounts ...");
  await tx.query("INSERT INTO ledger ...");
});
```

For PostgreSQL, the engine pins one pool client until commit or rollback. Manual
`BEGIN`/`COMMIT` queries still travel through the same session, but the helper
provides rollback-on-error behavior.

Unrelated concurrent operations on the same client now wait until an active
transaction callback commits or rolls back.

## Notifications

`listen()` and `notify()` now travel through the Ominipg session and work with
embedded or routed PostgreSQL workloads. Notification delivery is asynchronous
because it arrives on the output stream. Existing handlers remain synchronous
callbacks once a frame reaches the client.

The restrictions remain:

- PostgreSQL main database only;
- `pgPoolMax >= 2` because the listener pins one connection;
- strict channel identifiers;
- notifications are non-durable wake-up signals.

## Multiple clients

Older module-global engine state could make multiple inline clients interfere.
Every 0.9 session has independent state, so multiple private sessions or
multiple sessions on one shared Hypervisor can coexist safely.

They do not share a PGlite engine or PostgreSQL pool. If several clients should
share one logical database connection, share the `Ominipg` instance at the
application layer rather than opening multiple sessions.

## Session payload changes

The 0.9 codec preserves database-relevant values:

- `bigint`
- `Date`
- typed arrays and buffers
- `undefined`
- `NaN`, infinities, and negative zero

Binary values use raw attachments. Functions, symbols, custom class instances,
and cyclic values fail with a `TypeError`. Convert custom database values to
plain records or supported primitives before using them as query parameters or
routed configuration.

The default maximum decoded frame is 512 MiB. Configure both the workload and
client decoder if snapshots or rows can exceed it:

```ts
const workload = createOminipgWorkload({ maxFrameBytes });
const db = await Ominipg.connect({
  url,
  oxian: { dispatcher, maxFrameBytes },
});
```

## Removed internals

The release removes the runtime-selection modules, inline message shim, Web
Worker handler, Node worker entrypoint, and worker-overhead fixture. These were
not stable public APIs. Use exported Ominipg/Oxian surfaces rather than source
paths.

## Operational checklist

- Remove `useWorker` and assumptions about thread isolation.
- Decide whether each deployment uses a private topology, shared in-process
  topology, or remote Worker.
- For injected dispatchers, move provider callbacks and platform bindings into
  workload dependencies.
- Size Oxian capacity for open database sessions, not query throughput.
- Preserve explicit `db.close()` calls.
- Stop shared Workers and shut down their Hypervisor in the owning application
  lifecycle.
- Run a database-engine integration test in each target runtime.
- Test large snapshots against configured frame and platform memory limits.
- Verify notification pool sizing and transaction concurrency assumptions.

## Package subpaths

| Import                    | Purpose                                        |
| ------------------------- | ---------------------------------------------- |
| `@oxian/ominipg`          | Client, CRUD types, workload constants/factory |
| `@oxian/ominipg/auto`     | Runtime package provider descriptors           |
| `@oxian/ominipg/crud`     | Standalone CRUD compiler/API                   |
| `@oxian/ominipg/pglite`   | PGlite provider and memory config              |
| `@oxian/ominipg/pg`       | PostgreSQL provider                            |
| `@oxian/ominipg/workload` | Ominipg workload factory                       |
| `@oxian/ominipg/session`  | Session transport/protocol APIs                |
| `@oxian/ominipg/worker`   | Compatibility alias for workload exports       |

## Related documentation

- [Architecture](./ARCHITECTURE.md)
- [Oxian embedding and routing](./OXIAN.md)
- [Runtime support](./RUNTIMES.md)
