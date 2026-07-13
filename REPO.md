---
name: ominipg
kind: lib
summary: PostgreSQL toolkit for Deno supporting PGlite, worker isolation, direct Postgres connections, sync, and CRUD helpers.
depends_on:
tags:
  - database
  - postgres
  - pglite
  - crud
entrypoints:
  - src/client/index.ts
  - src/client/notifications.ts
  - src/client/crud/index.ts
  - src/worker/index.ts
  - docs/ARCHITECTURE.md
status: active
---

## Purpose

Database foundation used by Copilotz for local and remote PostgreSQL access, worker-mode isolation, sync, and typed CRUD operations.

## Read These First

- `src/client/index.ts`
- `src/client/crud/index.ts`
- `src/worker/index.ts`
- `docs/ARCHITECTURE.md`

## Common Task Locations

- Public client API: `src/client/`
- Direct PostgreSQL LISTEN/NOTIFY lifecycle: `src/client/notifications.ts`
- Worker bootstrap and DB execution: `src/worker/`
- Shared message types: `src/shared/`
- Examples and tests: `examples/`, `test/`

## Warnings

- The repo supports multiple connection modes; confirm whether the change applies to worker mode, direct mode, or both.
- Sync and schema behavior can affect Copilotz indirectly.
