---
name: ominipg
kind: lib
summary: Runtime-neutral PostgreSQL/PGlite toolkit whose connections execute as stateful Oxian workload sessions.
depends_on:
  - oxian-js
tags:
  - database
  - postgres
  - pglite
  - oxian
  - workers
  - crud
  - runtime-neutral
entrypoints:
  - src/client/index.ts
  - src/session/index.ts
  - src/session/workload.ts
  - src/worker/engine.ts
  - src/client/crud/index.ts
  - docs/ARCHITECTURE.md
status: active
---

## Purpose

Database foundation used by Copilotz for local or remote PostgreSQL access,
PGlite, sync, notifications, transactions, Drizzle, and typed CRUD. Every public
connection is an `ominipg.session.v1` Oxian workload; there is no inline engine,
Web Worker, or `worker_threads` data path.

## Read These First

- `docs/ARCHITECTURE.md`
- `docs/OXIAN.md`
- `docs/RUNTIMES.md`
- `src/client/index.ts`
- `src/session/workload.ts`
- `src/worker/engine.ts`

## Common Task Locations

- Public API, events, CRUD and Drizzle: `src/client/`
- Session protocol, codec, client and embedding: `src/session/`
- Stateful engine, adapters, schema, sync and diagnostics: `src/worker/`
- Optional providers and shared engine contracts: `src/providers/`,
  `src/shared/`
- Runtime/package verification: `scripts/`, `.github/workflows/verify.yml`
- Tests: `test/`

## Architecture Rules

- One Oxian dispatch owns one `OminipgEngine` and one explicit `EngineState`.
- The default private Hypervisor and in-process Worker are same-isolate and
  event-loop local; they are not thread, memory, crash, or security isolation.
- An injected dispatcher is application-owned and must not be shut down by an
  individual Ominipg client.
- Provider callbacks and platform bindings belong to the workload runtime.
- All public database features must use the session; do not add a direct bypass.
- The public dependency closure must stay free of runtime-specific globals,
  builtins, worker constructors, and `postMessage`.
- Streams are the data plane. Local events/callbacks are observation only.

## Warnings

- Oxian capacity counts long-lived database sessions rather than SQL queries.
- PGlite engines are independent and memory-heavy even on a shared host.
- PostgreSQL transactions rely on request ordering within one session; avoid
  unrelated concurrent queries during a transaction callback.
- Routed configuration must be wire-encodable. Functions and custom objects do
  not cross the session.
- Database provider support still varies by runtime despite the portable core.
- Sync and schema changes can affect Copilotz indirectly.
- `useWorker` is a deprecated no-op retained only for migration.
