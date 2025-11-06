## Roadmap

### Cross-Runtime Support (Node.js, Bun, Browser)

- **Goal**: Expand `@oxian/ominipg` beyond Deno so the client SDK and worker can
  run under standard Node.js, Bun, and browser environments without feature
  loss.
- **Status**: Planning

#### Proposed Implementation

- Draft a runtime abstraction layer centralizing feature detection (`isDeno`,
  `isNode`, `isBun`, `isBrowser`) and bridging APIs for filesystem access,
  process metrics, workers, and crypto.
- Replace `npm:`-prefixed imports with portable module specifiers, and lazily
  load environment-specific dependencies (`pg`, `@electric-sql/pglite`, worker
  bundles) to keep browser bundles lean.
- Produce a build pipeline (e.g. tsup/rollup) that emits runtime-targeted
  bundles, type definitions, and a prebuilt worker artifact for publication to
  npm/JSR.

#### Key Subtasks Discussed

- Wrap all `Deno.*` calls (RSS metrics, filesystem, process info) behind
  runtime-aware helpers that map to Node/Bun equivalents or graceful browser
  fallbacks.
- Redesign worker creation to pick the appropriate primitive (`new Worker` URL
  for browsers/Deno, `worker_threads.Worker` for Node/Bun) and ensure the
  bundled worker file is distributed.
- Guard direct Postgres mode behind Node/Bun checks with dynamic `import('pg')`
  so browsers do not attempt to bundle server-side drivers.
- Define and document runtime limitations (e.g. browser storage constraints,
  minimum Node/Bun versions) and add cross-runtime test plans (Node/Bun test
  runners, browser smoke tests).

### Pluggable Storage & Sync Providers

- **Goal**: Decouple Ominipg from PostgreSQL-only assumptions so local persistence can run on alternative engines (e.g. SQLite) while still syncing with remote Postgres.
- **Status**: Proposed

#### Proposed Implementation

- Introduce a dialect/provider abstraction for the query layer (identifier quoting, parameter placeholders, DDL differences, JSON handling) with PostgreSQL as the default implementation.
- Build a parallel provider targeting SQLite (or other embedded engines), adapting CRUD helpers, schema bootstrap, and migrations to the chosen dialect.
- Redesign change capture/outbox logic behind an engine-agnostic interface so we can plug in provider-specific triggers or hooks without relying on PL/pgSQL features.
- Separate the sync orchestrator into transport (remote Postgres) vs. storage adapters, making polling/replay strategies pluggable.

#### Key Subtasks Discussed

- Wrap all SQL emission in a `SqlDialect` interface (`quoteIdentifier`, `placeholder(n)`, `buildUpsert`, `supportsReturning`, JSON helpers) and route CRUD/query builders through it.
- Add a generic `StorageAdapter` interface that implements change capture (triggers, queues, notifications) and expresses capabilities such as transaction semantics, JSON support, default values.
- Rewrite conflict resolution and LWW handling to operate on provider-neutral payloads (e.g. JSON text) instead of PostgreSQL-specific types.
- Expand the test matrix to cover each storage provider end-to-end, including sync scenarios against a PostgreSQL remote.
