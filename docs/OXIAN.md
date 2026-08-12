# Oxian embedding and routing

Ominipg 0.9 has one execution model: every database connection is an Oxian
workload session. The deployment choice is whether the Oxian dispatcher sends
that workload to a private in-process worker, a shared in-process worker, or a
worker attached to a Hypervisor.

## Why a long-lived workload

A database client is stateful. It needs to retain a PGlite instance or pool,
transaction connection, sync service, subscriptions, and schema metadata across
many API calls. Ominipg therefore uses one long-lived Oxian dispatch per
connection rather than one dispatch per query.

The operation input and output remain open for the session. Ominipg multiplexes
request, response, and event frames over those streams until `db.close()`.

## Default private topology

No Oxian setup is required for the common case:

```ts
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
});
```

Internally, Ominipg creates one Hypervisor, binds one in-process Worker carrying
the `ominipg.session.v1` workload, and opens one session. Provider callbacks and
non-serializable PGlite configuration stay process-local. `db.close()` owns all
private cleanup.

Each private session owns a unique event-fabric topic, so independently embedded
libraries cannot collide. Frames are addressed to one logical connection; the
topic is a rendezvous namespace, not a work-broadcast channel. Closing the
session stops its Worker, unregisters the Hypervisor binding, and releases the
topic.

The private topology is event-loop local. It executes the complete Oxian v1
lifecycle but does not create a thread, isolate, listener, or WebSocket. Because
there is no intermediary socket lifetime, Oxian does not apply automatic
connection-age rotation to this in-process path. A durable database session
remains attached until `db.close()`, explicit Worker/Hypervisor shutdown, or a
genuine lifecycle failure.

## Shared application topology

Use a shared Hypervisor when an application or higher-level library owns several
worker-enabled capabilities:

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.21.0-rc.3/hypervisor";
import { createWorker } from "jsr:@oxian/oxian-js@0.21.0-rc.3/worker";
import {
  createOminipgWorkload,
  Ominipg,
  OMINIPG_SESSION_WORKLOAD,
} from "jsr:@oxian/ominipg";
import { createPGliteProvider } from "jsr:@oxian/ominipg/pglite";

const local = {
  type: "in-process",
  config: { topic: "embedded-application" },
} as const;
const hypervisor = createHypervisor({ transports: [local] });

const worker = createWorker({
  id: "embedded-application",
  transport: local,
  capacity: 8,
  workloads: {
    [OMINIPG_SESSION_WORKLOAD]: createOminipgWorkload({
      dependencies: {
        pgliteProvider: createPGliteProvider(),
      },
    }),
    "application.turn.v1": applicationTurnWorkload,
  },
});
await worker.ready;

const first = await Ominipg.connect({
  url: ":memory:",
  oxian: { dispatcher: hypervisor },
});
const second = await Ominipg.connect({
  url: ":memory:",
  oxian: { dispatcher: hypervisor },
});

await first.close(); // second and the shared topology remain alive
await second.close();

await worker.stop();
await worker.closed;
await hypervisor.shutdown();
```

Every session still owns a separate engine. Sharing a Hypervisor or Worker does
not share PGlite instances, pools, sync metadata, or transactions.

This topology is suitable for embedding Ominipg in a library: the parent
application can own one Hypervisor and bind Ominipg alongside its other
workloads. The library does not need to enable an HTTP or WebSocket listener.

## Runtime-owned dependencies

Provider functions load code and therefore cannot cross the framed stream. The
workload process should normally own them:

```ts
createOminipgWorkload({
  dependencies: {
    pgliteProvider: createPGliteProvider(),
    pgProvider: createPgProvider(),
    getRssMb: hostMemoryProbe,
  },
});
```

For multi-tenant or heterogeneous workers, resolve dependencies from dispatch
metadata:

```ts
createOminipgWorkload({
  async resolveDependencies(metadata) {
    const tenantId = String(metadata.tenantId);
    return dependencyRegistry.forTenant(tenantId);
  },
});

const db = await Ominipg.connect({
  url: tenantDatabaseUrl,
  oxian: {
    dispatcher: hypervisor,
    metadata: { tenantId },
  },
});
```

Treat metadata as routing input, not trusted authorization by itself. The host
must authenticate the caller and validate tenant/worker selection before
dispatch.

When a private embedded session is used, `pgliteProvider`, `pgProvider`,
`pgliteConfig`, and `runtime.getRssMb` are captured directly by the private
workload. When an external dispatcher is used:

- callback providers are not sent;
- module specifier descriptors may be sent;
- serializable `pgliteConfig` may be sent;
- functions, custom class instances, and cyclic values are rejected;
- workload-configured dependencies take precedence.

If the caller and worker use different runtimes, configure dependencies on the
worker. A Deno `npm:` module specifier is not necessarily the right choice for a
Node, Bun, or Cloudflare worker.

## Remote Oxian worker

`createOminipgWorkload()` is the same handler supplied to an outbound Oxian
worker:

```ts
import { createWorker } from "jsr:@oxian/oxian-js@0.21.0-rc.3/worker";
import {
  createOminipgWorkload,
  OMINIPG_SESSION_WORKLOAD,
} from "jsr:@oxian/ominipg/workload";

const worker = createWorker({
  id: "database-worker",
  transport: {
    type: "websocket",
    config: { url: hypervisorWorkerUrl },
  },
  activate: ({ workerId }) => attempts.activate(workerId),
  register: ({ identity }) => credentials.issue(identity),
  handshake: ({ rotation, bootstrap }) =>
    workerState.persistRotationAndBootstrap(rotation, bootstrap),
  capacity: 8,
  workloads: {
    [OMINIPG_SESSION_WORKLOAD]: createOminipgWorkload({
      dependencies: { pgProvider: createPgProvider() },
    }),
  },
});

await worker.ready;
await worker.closed;
```

The application process that owns an Oxian Hypervisor can pass it directly:

```ts
const db = await Ominipg.connect({
  url: "postgresql://database.internal/app",
  oxian: {
    dispatcher: hypervisor,
    target: { workerId: "database-worker" },
    metadata: { tenantId },
    signal: request.signal,
    deadlineAtMs: Date.now() + 60_000,
  },
});
```

Oxian's worker WebSocket is an outbound worker attachment protocol. Ominipg does
not expose that socket as a browser/client database protocol. A remote requester
needs application ingress that authenticates it and dispatches through the
owning Hypervisor.

WebSocket connections still use the Hypervisor's configured age rotation. An
application hosting long-lived remote Ominipg sessions must choose a connection
lifetime and drain policy compatible with its infrastructure and database
transaction limits; an in-flight stateful session cannot be replayed after its
acceptance boundary.

## In-process versus WebSocket

| Concern                         | In-process event fabric              | WebSocket Worker                           |
| ------------------------------- | ------------------------------------ | ------------------------------------------ |
| Physical connection             | Same-realm addressed events          | WSS socket                                 |
| Oxian handshake/lifecycle       | Complete `oxian.worker.v1` lifecycle | Complete `oxian.worker.v1` lifecycle       |
| Ominipg session framing         | Yes                                  | Yes                                        |
| Oxian framing/credit            | Yes, through the shared codec/kernel | Yes, through the shared codec/kernel       |
| Backpressure/cancellation       | Credited Web Streams                 | Credited Web Streams                       |
| Event-loop isolation            | No                                   | Yes when worker is another process/isolate |
| Memory/crash/security isolation | No                                   | Deployment-dependent                       |
| Network/TLS overhead            | None                                 | Deployment-dependent                       |
| Relative overhead               | Lower physical transport cost        | Higher, with isolation/routing             |

The in-process path is normally lighter than loopback WebSocket execution. It
still runs the same Oxian codec, lifecycle, protocol ordering, flow control, and
Ominipg stream protocol. That consistency lets an application move a workload
out of process without rewriting its database API or changing lifecycle
semantics.

## Capacity and database concurrency

Oxian capacity counts active Ominipg sessions, not individual SQL queries. A
session remains active from `connect()` through `close()`. Size worker capacity
for concurrently open databases and ensure database pools, PGlite memory, and
runtime limits can support that many engines.

PGlite has one backend per engine and can be memory-heavy. Sharing an Oxian host
does not make multiple PGlite engines share a WASM heap. Prefer a small number
of long-lived sessions over one connection per request.

## Cancellation and shutdown

- `db.close()` sends the protocol `close` operation and waits for workload
  completion.
- A transport `AbortSignal` cancels the whole session.
- The workload closes subscriptions, sync services, active transactions, and
  database resources.
- Private Worker and Hypervisor cleanup follows session cleanup.
- Injected dispatchers, Workers, and Hypervisors are never shut down by
  `db.close()`.
- Topology owners should stop Workers and then shut down the Hypervisor.

JavaScript cancellation is cooperative. An in-process workload cannot forcibly
interrupt arbitrary synchronous CPU work.

## Session payload guidance

The codec supports ordinary objects/arrays and database-relevant special values.
Keep configuration declarative. Put credentials, providers, open handles,
bindings, and platform objects in workload dependencies or a runtime-owned
registry rather than session frames.

Large binary values are attached without base64. The default frame limit is 512
MiB and can be lowered or raised independently at each decoder. Platform and
Oxian transport limits may be lower, but an Ominipg frame can span many Oxian
chunks.

## Related documentation

- [Architecture](./ARCHITECTURE.md)
- [Runtime support](./RUNTIMES.md)
- [Oxian worker documentation](https://github.com/AxionCompany/oxian-js/blob/main/docs/workers.md)
