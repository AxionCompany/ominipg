# PGlite Memory Characteristics

This note summarizes our recent measurements of the WebAssembly build of PostgreSQL that ships with `@electric-sql/pglite`. The goal is to help decide when the in-process PGlite runtime is a good fit and when a native PostgreSQL server (or another driver) is more appropriate.

## Memory Profile

All measurements were collected on macOS 12 (Apple M1) using Deno 2.4 with the scripts under `experiments/memory/`.

| Scenario | Script | Peak RSS delta | Notes |
| --- | --- | --- | --- |
| Baseline Deno runtime | `baseline.ts` | ~45 MB | No database loaded; establishes the minimum process footprint. |
| Worker created (no DB) | `worker_spawn.ts` | ~60 MB | Worker isolate alone adds ~15 MB over baseline. |
| PGlite in-process (memory://) | `pglite_direct.ts` | ~460 MB | WASM heap expands to ~188 MB; RSS remains high after `close()`. |
| Ominipg worker + PGlite | `worker_pglite.ts` | 316 MB during `connect`, ~700 MB after `close()` | Host process + worker each retain their WASM heaps until GC reclaims the buffers. |
| PGlite with NodeFS backing store | `pglite_nodefs.ts` | ~530 MB | Switching from in-memory FS to `file://` does **not** reduce the initial footprint. |
| node-postgres Pool (native Postgres) | `pg_pool.ts` | ~52 MB | Demonstrates the overhead of using the NPM `pg` client without PGlite. |

The numbers show that even a single PGlite instance costs roughly 400–500 MB of RSS. Every additional worker incurs the same cost because each isolate loads its own copy of the WASM module and filesystem bundle.

## Why PGlite Uses So Much Memory

- **Bundled Postgres filesystem** – PGlite ships with `pglite.data`, a pre-populated virtual filesystem that contains a full PostgreSQL installation and extension tarballs. The bundle is loaded wholesale into an ArrayBuffer during module initialization ([PGlite docs](https://pglite.dev/docs/about)).
- **Large WASM linear memory** – The build enables `ALLOW_MEMORY_GROWTH`, but the runtime quickly grows the heap to roughly 188 MB to satisfy PostgreSQL shared-memory needs. Our `pglite_initial_memory.ts` script shows `Module.HEAPU8.buffer.byteLength === 197,525,504` even when we request a smaller `initialMemory`.
- **One backend per isolate** – Unlike a native cluster with a postmaster that forks lightweight backends, each PGlite instance embeds one backend inside the host process. Launching extra workers multiplies the footprint in direct proportion to the number of isolates.
- **Garbage collection latency** – Deno (via V8) does not immediately release the large ArrayBuffers that back the WASM heap. RSS therefore remains high after `close()` until a GC cycle runs. Calling `globalThis.gc?.()` with `--v8-flags=--expose-gc` can make the effect visible, but it does not shrink the underlying requirement.

## When PGlite Is Still a Good Fit

Despite the heavy baseline, there are situations where the convenience of an embedded PostgreSQL outweighs the memory cost:

- **Local-first and offline-first development** – PGlite lets you ship full PostgreSQL semantics (including triggers, CTEs, and extensions such as `pgvector`) inside a desktop or browser app without a separate server ([ElectricSQL positioning](https://electric-sql.com/blog/introducing-pglite)).
- **Automated testing that relies on PostgreSQL behaviour** – Test suites that need deterministic control over a Postgres engine but cannot spin up containers can instantiate PGlite on demand. The scripts in `experiments/memory/` illustrate how to measure and cap the impact during CI runs.
- **Edge functions with short-lived, single-tenant workloads** – If an edge worker needs a temporary Postgres-compatible store and the platform provides >512 MB of memory, PGlite offers richer features than SQLite with zero external dependencies.
- **Education and prototyping** – PGlite provides an approachable way to teach or prototype Postgres features without forcing users to install a server locally.

## When to Prefer Alternatives

- **Resource-constrained environments** – Devices or sandboxes capped below ~512 MB should rely on SQLite or a remote PostgreSQL instance. Even one PGlite worker consumes most of the budget.
- **Multi-user or high-concurrency services** – Native PostgreSQL supports hundreds of concurrent sessions and efficient connection pooling. PGlite offers a single backend per instance and serializes work through the host event loop.
- **Production backends** – For applications that already run a PostgreSQL cluster, using the direct `pg` driver (`useWorker: false` in Ominipg) keeps RSS near 50 MB and avoids duplicated WASM heaps.

## Practical Guidance

- Only opt into worker mode (`useWorker: true`) when you need cross-thread isolation or synchronization features; otherwise prefer direct Postgres connections.
- If you do use PGlite, reuse a single instance per process whenever possible. Spawning workers per request multiplies the memory cost linearly.
- Monitor RSS with utilities like `ps -o rss` or `Deno.memoryUsage()` if you run benchmarks. The scripts in `experiments/memory/` provide a reproducible harness.
- Expose V8 GC (`deno run --v8-flags=--expose-gc`) during diagnostics to differentiate between live memory and reclaimable buffers.

## References

- `experiments/memory/` scripts in this repository (baseline, worker, PGlite, NodeFS, pg pool, WASM heap probe).
- PGlite project documentation: [https://pglite.dev/docs/about](https://pglite.dev/docs/about).
- ElectricSQL announcement explaining the target use cases: [https://electric-sql.com/blog/introducing-pglite](https://electric-sql.com/blog/introducing-pglite).

