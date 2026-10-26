# Changelog

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
