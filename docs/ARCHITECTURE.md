# Architecture

Ominipg is an Oxian-native database workload. The public client, database
engine, and execution topology are separate layers, so the same database API can
run embedded in another application or on a worker attached to an Oxian
Hypervisor.

## Thirty-thousand-foot view

```mermaid
flowchart LR
  subgraph Application["Application"]
    API["Ominipg API\nquery · CRUD · Drizzle · sync"]
    SC["Session client\nrequest/response/event multiplexer"]
    API --> SC
  end

  SC --> D{"Oxian dispatcher"}

  subgraph Embedded["Embedded topology — same isolate"]
    H["Hypervisor"]
    W["Worker\ntransport: in-process"]
    IW["In-process workload"]
    H <-->|"addressed event fabric / oxian.worker.v1"| W
    W --> IW
  end

  subgraph Routed["Routed topology"]
    HV["Hypervisor"]
    RW["Attached remote worker"]
    HV -->|"oxian.worker.v1 / WSS"| RW
  end

  D --> H
  D --> HV
  IW --> E1["OminipgEngine"]
  RW --> E2["OminipgEngine"]
  E1 --> DB1["PGlite or PostgreSQL"]
  E2 --> DB2["PGlite or PostgreSQL"]
```

One `Ominipg.connect()` call opens one long-lived `ominipg.session.v1` dispatch.
That dispatch creates one `OminipgEngine`, and the engine owns all mutable state
for the lifetime of the connection. There are no module-level database
singletons.

## Layers

### Public API

`src/client/index.ts` owns the user-facing `Ominipg` class. It provides:

- raw queries and transaction callbacks;
- sync, sequence sync, PGlite data-directory exports, and diagnostics;
- PostgreSQL `LISTEN`/`NOTIFY` subscriptions;
- CRUD helpers and the Drizzle proxy adapter;
- client lifecycle and typed events.

CRUD and Drizzle do not bypass the session. Both compile their operations to SQL
and call the same `Ominipg.query()` method as raw callers.

### Session client

`src/session/client.ts` adapts an Oxian dispatch handle into a stateful client:

- a monotonically increasing request ID correlates responses;
- multiple request promises share one input/output byte stream;
- notification and subscription-state frames are delivered as events;
- request timeouts reject the caller while accepted raw work continues to drain;
  PGlite gates the whole session, while pooled PostgreSQL gates only the
  affected named transaction or default/unlaned request group;
- closing rejects pending requests and closes subscriptions;
- injected dispatchers remain owned by the embedding application.

The accepted dispatcher shape is the minimal Oxian `Dispatcher` contract.
Hypervisors expose that contract directly, and an application can provide
another adapter with the same lifecycle.

### Ominipg session protocol

`src/session/protocol.ts` defines `ominipg.session.v1`. Operations are:

- `initialize`
- `query`
- `sync`
- `sync-sequences`
- `dump-data-dir`
- `diagnostics`
- `listen`
- `unlisten`
- `notify`
- `close`

Every frame has an Ominipg protocol identifier and is one of `request`,
`response`, or `event`. Errors cross the boundary as name, message, and optional
stack fields, then become `Error` objects on the client.

`src/session/codec.ts` is runtime-neutral and handles arbitrary stream chunk
boundaries. A frame contains:

```text
4 bytes  "OMPG"
4 bytes  tagged-JSON header length (uint32, big endian)
4 bytes  binary attachment length (uint32, big endian)
N bytes  UTF-8 tagged JSON
M bytes  raw binary attachments
```

Tagged values preserve `bigint`, `Date`, `Uint8Array`/buffers, `undefined`,
non-finite numbers, and negative zero. Binary values remain raw attachments, so
PGlite data-directory exports do not pay base64 expansion. Functions, symbols,
cyclic values, and custom object instances are rejected because they are
process-local.

The default decoder limit is 512 MiB per frame. A routed client can set
`oxian.maxFrameBytes`; a workload owner can set
`createOminipgWorkload({ maxFrameBytes })`. Oxian can split one Ominipg frame
across any number of transport chunks.

### Workload

`createOminipgWorkload()` returns an Oxian `WorkerWorkHandler`. Each invocation:

1. resolves runtime-owned database providers;
2. creates one `OminipgEngine`;
3. reads framed requests and schedules commands on the engine's supported lanes;
4. writes correlated responses and asynchronous database events;
5. closes engine resources when the client closes, input ends, or the Oxian
   operation is cancelled.

PGlite dispatch awaits each command. PostgreSQL schedules independent commands
concurrently and preserves arrival order within each transaction lane. A named
transaction retains one checked-out client from BEGIN through COMMIT/ROLLBACK.
Each transaction uses its own scheduling key.

Dependencies can be fixed or selected from Oxian metadata:

```ts
createOminipgWorkload({
  dependencies: { pgliteProvider, pgProvider },
  resolveDependencies: async (metadata) => dependenciesFor(metadata.tenantId),
});
```

Fixed dependencies take precedence over provider descriptors sent by the client.
This is the preferred model for remote or multi-runtime workers.

### Engine

`src/worker/engine.ts` is the stateful domain façade. The `src/worker/` name is
retained for package compatibility, but these modules do not install Web Worker
or `worker_threads` listeners.

Every `EngineState` owns:

- the main PGlite adapter or PostgreSQL pool;
- the optional sync pool and logical replication service;
- provider callbacks and PGlite configuration;
- schema metadata and active extensions;
- edge identity, LWW settings, and recently pushed rows;
- sync timers and lifecycle flags;
- notification subscriptions and listener hub.

The engine performs no runtime-global filesystem or memory probing. Optional
host capabilities such as RSS measurement are injected.

## Topologies and ownership

### Private embedded — default

When `oxian` is absent, Ominipg creates a private Hypervisor and an in-process
Worker carrying one workload with capacity one, then dispatches the session
through the Hypervisor. `db.close()` closes the engine, Worker, and Hypervisor.

This path stays inside one JavaScript isolate. Oxian carries encoded control and
binary frames through an addressed event fabric and runs the same handshake,
readiness, heartbeat, lease, acceptance, credit, cancellation, drain, and
shutdown state machines as WebSocket Workers. It creates no socket, Web Worker,
worker thread, or runtime isolate.

### Shared embedded

An application can place a Worker carrying `createOminipgWorkload()` on its own
Hypervisor and pass that Hypervisor as `oxian.dispatcher`. Multiple database
sessions can share the topology while retaining separate engines. `db.close()`
closes only its session; the application owns the shared Worker and Hypervisor.

An embedding library can expose worker-enabled functionality without opening a
server or WebSocket.

### Hypervisor-routed

The same workload handler can run in an Oxian worker connected outbound to a
Hypervisor. The server-side application passes that Hypervisor (or an adapter)
as the Ominipg dispatcher. Oxian handles selection, capacity, acceptance,
cancellation, and remote byte-stream transport.

The Ominipg client is not itself a browser-to-Hypervisor requester protocol. A
browser or another remote caller needs an application-owned ingress/bridge to a
process that can dispatch work.

## Database flows

### Query

```mermaid
sequenceDiagram
  participant App
  participant Client as OminipgSessionClient
  participant Oxian
  participant Workload
  participant Engine
  participant DB

  App->>Client: query(sql, params)
  Client->>Oxian: request frame on session input
  Oxian->>Workload: stream bytes
  Workload->>Engine: query(sql, params)
  Engine->>DB: execute
  DB-->>Engine: rows
  Engine-->>Workload: rows
  Workload-->>Client: response frame
  Client-->>App: { rows }
```

### Transaction

`Ominipg.transaction()` sends `BEGIN`, invokes the callback, then sends `COMMIT`
or `ROLLBACK`. PGlite already has one backend per engine. The PostgreSQL adapter
checks out a pool client on `BEGIN` and retains it for every session query until
the transaction ends. Closing an engine with an active transaction attempts a
rollback before releasing the connection.

Savepoint rollback (`ROLLBACK [WORK|TRANSACTION] TO [SAVEPOINT] name`) retains
the pinned PostgreSQL client, including when that statement fails. Full
`COMMIT`/`ROLLBACK` and their `END`/`ABORT` aliases release it; `AND CHAIN`
retains it for the next transaction. A failed full ending discards the client
rather than returning a possibly open transaction to the pool. `COMMIT PREPARED`
and `ROLLBACK PREPARED` are distinct from endings of the current lane.
`PREPARE TRANSACTION`, which ends the current transaction, remains outside the
supported managed-lane contract.

Managed transaction control must be a single leading statement in its query. The
adapter recognizes comments and quoted names and refuses control-led
multi-statement batches before sending them. Ordinary schema/function SQL is not
parsed or restricted by this classifier. Transaction control embedded later in
an ordinary raw SQL batch is outside the supported managed-lane contract and
remains unclassified. Broader raw batching would require provider-level
transaction-state observation; this classifier does not provide that guarantee.

The callback executor is valid only while its callback is active. Both `query`
and `queryRaw` refuse retained calls after callback success or failure,
including while the terminal acknowledgement is still pending. Already-admitted
statements are drained before terminal SQL. PGlite and PostgreSQL share this
lifecycle; PGlite serializes whole callbacks, while PostgreSQL uses an
independent pinned lane per callback and can run other queries or transactions
concurrently.

`BEGIN` is covered by cleanup too: a request timeout can conceal a successfully
opened transaction. The existing session gate drains its raw response before a
rollback is sent on the same lane. If rollback fails or cannot be confirmed, the
client refuses further use and closes its workload session. Cleanup bypasses the
public close queue so it cannot wait on its own active transaction. The original
transaction error remains primary; `close()` retains any cleanup failure.

PostgreSQL timeout gating uses the existing pending-request and idle-waiter
state, scoped by the existing transaction lane. A timed-out pool checkout must
not block the named transaction that can release its connection. This includes
ordinary statements before callback completion, not just COMMIT/ROLLBACK. Calls
in the affected lane still wait for their raw responses before starting a new
request deadline. New LISTEN, other non-query and unlaned operations share the
default group. UNLISTEN can remove a subscription using its already-pinned
listener independently, after all accepted work for that subscription drains;
this also preserves a pending LISTEN's order. Unsubscribe does not release the
hub's shared connection; it remains charged until actual hub close/disconnect.
The plain routing envelope is captured before awaiting admission, and encoding
failures install no pending timer or raw waiter. PGlite retains whole-session
serialization. Only the trusted initialized engine concurrency response enables
this distinction. No extra pool, connection budget, fail-fast checkout policy,
lane registry or public API is added.

A timed-out `COMMIT` is still an unknown outcome. Attempting cleanup does not
prove that business writes rolled back, and callers must not blindly replay
them. Timeout rejection is not proof of raw resource release: cleanup can remain
pending while an accepted database request drains.

For consistent reads, use a short ordinary read-only REPEATABLE READ
transaction. In a `transaction()` callback, issue
`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` before reading; the
callback API has already sent `BEGIN`. Raw session callers can instead send
`BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ` on a named transaction lane,
followed by their reads and `COMMIT` or `ROLLBACK` on that same lane.

Each PostgreSQL transaction holds one connection. Independent transactions run
up to the available pool capacity and additional transactions queue. The
accounted pool exposes `options`, `connect()`, client `release()`, and `end()`;
the provider enforces its configured maximum and checkout queue. PGlite keeps
its ordinary single-engine transaction serialization.

### PostgreSQL provider fault ownership

The accounted boundary observes native client errors for the whole checkout,
including transaction gaps and return. A fault latches that borrow closed to
later SQL and requests client destruction on its eventual return. It does not
return capacity early, retry a statement or establish the outcome of an
uncertain COMMIT. A throwing return retains its observer and existing cleanup
charge until return succeeds.

Native pool errors from idle clients are observed before the first checkout and
through pool shutdown. Unknown/failed shutdown retains observation. Both the
main PostgreSQL pool and the remote sync pool use this boundary; PGlite remains
an independent in-process default.

Errors travel through the existing engine/workload/session diagnostic route. The
same native Error object observed through pool/listener paths produces one
global diagnostic and still reaches the affected subscription error/state
handlers. Different Error objects from one outage remain distinct, and session
diagnostic delivery is best-effort. Subscription-specific frames do not repeat
global delivery. Host diagnostic callbacks that throw or reject cannot interrupt
resource cleanup. Native SQL promises still reject independently; an error event
is not a transaction receipt or automatic retry instruction.

Custom PostgreSQL providers must implement the existing client event methods as
well as query/release. Pools exposing native error events are observed too. No
new service, worker lease or public topology option is introduced.

### Sync

Sync belongs to the engine session:

1. bootstrap creates user schema and sync infrastructure;
2. initial synchronization reconciles local and remote data;
3. logical replication pulls remote changes when configured;
4. local triggers track changes;
5. `sync()` pushes a batch to PostgreSQL;
6. edge identity and the configured LWW column suppress echoes and resolve
   supported conflicts.

Session shutdown stops replication and timers before closing database pools.

### Notifications

PostgreSQL notifications are asynchronous session events. The first `listen()`
creates one listener hub and pins one pool connection; channels and callbacks
are multiplexed over it. Connection failure enters `reconnecting`, then active
channels are reissued with capped backoff. `pgPoolMax` must be at least two.

PGlite and sync-only notification use is rejected. Notifications remain
best-effort wake-up signals; durable state belongs in tables.

## Runtime boundary

The public dependency closure uses `crypto`, Web Streams, typed arrays,
`TextEncoder`/`TextDecoder`, `Blob`, timers, and promises. It contains no direct
Deno, Node, Bun, Cloudflare, Web Worker, `postMessage`, or `worker_threads` API.

Database providers are capability boundaries. A runtime-neutral session does not
make every database engine available in every runtime: filesystem-backed PGlite
needs filesystem support, and PostgreSQL/logical replication need a compatible
driver and network model.

## Design consequences

- Embedded execution is lighter than loopback WebSocket execution, but slightly
  heavier than a direct method call because it preserves the unified framed
  session contract.
- Same-isolate execution provides lifecycle, scheduling, cancellation, and
  ownership—not CPU, memory, crash, or security isolation.
- Streams are the data plane because they carry backpressure and cancellation;
  JavaScript callbacks/events are used only for local observation.
- One long-lived dispatch preserves connection, transaction, subscription, and
  sync state naturally.
- Explicit providers keep runtime-specific imports out of the core and make
  worker runtime ownership visible.
- An injected dispatcher or Hypervisor always outlives individual Ominipg
  sessions unless its application owner shuts it down.

## Related documentation

- [Oxian embedding and routing](./OXIAN.md)
- [Runtime support](./RUNTIMES.md)
- [Migrating to 0.9](./MIGRATION_0_9.md)
- [Sync](./SYNC.md)
- [PostgreSQL notifications](./NOTIFICATIONS.md)

### Terminal shutdown guarantees

PostgreSQL shutdown seals transaction admission, drains admitted pinned SQL, and
returns late successful opens directly. Existing pins are returned before
waiting for queued opens, so shutdown cannot deadlock on its own pool capacity.
It attempts every rollback/return and pool shutdown, aggregates cleanup
failures, and retains any failed physical return in the pool's owned cleanup
handles.

Graceful session close and input EOF drain accepted requests before closing the
engine. Transport cancellation closes engine resources directly.
