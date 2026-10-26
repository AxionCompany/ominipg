# Changelog

## 0.11.1

- Add `transaction(work, { isolation?, readOnly? })` on both the database and
  CRUD facade. PostgreSQL and PGlite apply isolation/access mode directly on
  `BEGIN`, eliminating a separate `SET TRANSACTION` for read snapshots.
- Defer callback transaction startup until its first query. Empty callbacks
  issue no SQL. PostgreSQL batches `BEGIN` with an unparameterized first
  statement; parameterized statements keep bound parameters and separate driver
  calls. Workloads advertise support; older workloads use explicit `BEGIN`.
- Preserve raw transaction lanes, cleanup, and first-statement error recovery,
  including batch parse errors that can prevent `BEGIN` itself from executing.

For N statements, PostgreSQL query calls fall from N + 2 to N + 1 when the first
statement has no parameters (including commit). A read-only repeatable-read
transaction falls from N + 3 to N + 1, or N + 2 with a parameterized first
query. Empty callbacks fall from two calls to zero.

## 0.11.0 — Breaking

Removed the read-snapshot API and protocol without deprecation:
`withReadSnapshot`, `OminipgReadSnapshot`, `OminipgSnapshotCleanup`, snapshot
options and cleanup observers, engine `openReadSnapshot`/`queryReadSnapshot`/
`closeReadSnapshot`, and the `snapshot-open`, `snapshot-query`, and
`snapshot-close` operations and capability handshake. PostgreSQL pair
reservations (`reservePair`) and PGlite exclusive snapshot draining are removed.
Upgrade clients and workloads together; old snapshot requests are unsupported.

Use short ordinary read-only REPEATABLE READ transactions instead:

```ts
const result = await db.transaction(async (tx) => {
  await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  return await tx.query("SELECT * FROM records WHERE id = $1", [recordId]);
});
```

The callback API already sends `BEGIN`, commits on success, and rolls back on
failure. Raw session callers can send
`BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ`, read, and finish with
`COMMIT` or `ROLLBACK`, using the same named transaction lane for every
statement. PostgreSQL transactions each use one pooled connection, run
independently up to available pool capacity, and queue beyond it. PGlite retains
ordinary serialized transactions. Query, transaction, sync, notification, and
PGlite data-directory export behavior is otherwise unchanged.
