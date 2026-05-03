# Migration Guide: 0.5.x to 0.6.x

Ominipg 0.6 makes PGlite and PostgreSQL drivers explicit providers. This keeps
the core package lighter, enables the npm build for Node.js, and avoids loading
database engines you do not use.

This is a breaking change for code that calls `Ominipg.connect()` with PGlite,
direct PostgreSQL, or sync.

---

## Checklist

1. Upgrade Ominipg to `0.6.x`.
2. Import the provider helper for each database engine you use.
3. Pass providers to `Ominipg.connect()`.
4. Install optional peer dependencies in Node.js apps.
5. Add `useWorker: true` when you want the old PGlite worker behavior.

---

## Version and Install

### Deno

The built-in Deno providers load compatible npm engine versions lazily. No
engine import-map entries are required unless you pass custom providers with
bare specifiers.

```typescript
import { Ominipg } from "jsr:@oxian/ominipg@0.6";
import { createPgProvider } from "jsr:@oxian/ominipg@0.6/pg";
import { createPGliteProvider } from "jsr:@oxian/ominipg@0.6/pglite";
```

### Node.js

Ominipg 0.6 publishes an ESM-only npm package for Node.js 22+.

```bash
npm install @oxian/ominipg
```

Install only the engine packages your app uses:

```bash
# PGlite local databases
npm install @electric-sql/pglite

# Direct PostgreSQL or sync
npm install pg pg-logical-replication
```

```typescript
import { Ominipg } from "@oxian/ominipg";
import { createPgProvider } from "@oxian/ominipg/pg";
import { createPGliteProvider } from "@oxian/ominipg/pglite";
```

---

## PGlite Connections

Ominipg 0.6.1+ defaults to PGlite `0.4.5` for Deno and declares
`@electric-sql/pglite` `^0.4.5` as the optional npm peer for Node.js.

PGlite's own upgrade guidance treats minor-version upgrades as potentially
breaking for persisted PGlite data directories. Fresh `:memory:` databases and
new `file://` databases should work normally, but existing PGlite `0.3.x`
database files should be migrated with a dump/import flow before opening them
with PGlite `0.4.x`.

### Before 0.6

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  schemaSQL: [`CREATE TABLE users (id TEXT PRIMARY KEY)`],
});
```

### 0.6+

```typescript
import { createPGliteProvider } from "jsr:@oxian/ominipg/pglite";

const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
  schemaSQL: [`CREATE TABLE users (id TEXT PRIMARY KEY)`],
});
```

The same applies to persistent PGlite URLs:

```typescript
const db = await Ominipg.connect({
  url: "file://./data/app.db",
  pgliteProvider: createPGliteProvider(),
});
```

---

## Worker Mode

In 0.5.x, PGlite ran through a worker by default. In 0.6+, PGlite without sync
runs in-process by default.

This is usually faster and avoids worker overhead, but it means PGlite work
shares the main isolate or Node.js process.

### Keep the old worker behavior

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
  useWorker: true,
});
```

Sync still uses worker mode by default because it runs background replication
work.

---

## Direct PostgreSQL

### Before 0.6

```typescript
const db = await Ominipg.connect({
  url: "postgresql://user:pass@host:5432/db",
});
```

### 0.6+

```typescript
import { createPgProvider } from "jsr:@oxian/ominipg/pg";

const db = await Ominipg.connect({
  url: "postgresql://user:pass@host:5432/db",
  pgProvider: createPgProvider(),
});
```

Direct PostgreSQL without sync still uses direct mode by default.

---

## Local-First Sync

Sync uses both engines: PGlite for the local database and PostgreSQL/logical
replication for the remote database.

### Before 0.6

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://user:pass@host:5432/db",
  schemaSQL: [`CREATE TABLE todos (id SERIAL PRIMARY KEY, title TEXT)`],
});
```

### 0.6+

```typescript
import { createPgProvider } from "jsr:@oxian/ominipg/pg";
import { createPGliteProvider } from "jsr:@oxian/ominipg/pglite";

const db = await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://user:pass@host:5432/db",
  pgliteProvider: createPGliteProvider(),
  pgProvider: createPgProvider(),
  schemaSQL: [`CREATE TABLE todos (id SERIAL PRIMARY KEY, title TEXT)`],
});
```

---

## PGlite Extensions

Extensions still use `pgliteExtensions`, but PGlite itself now comes from the
provider.

### Before 0.6

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteExtensions: ["uuid_ossp", "vector"],
});
```

### 0.6+

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
  pgliteExtensions: ["uuid_ossp", "vector"],
});
```

---

## Custom Providers

The built-in helpers are the normal path, but 0.6 also supports custom
providers. This is useful when an application wants to control exactly how an
engine is loaded.

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: {
    loadPGlite: () => import("@electric-sql/pglite"),
  },
});
```

Custom callback providers can run in-process. Worker mode and sync require
serializable module specifiers because worker messages cannot carry functions:

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: {
    moduleSpecifier: "@electric-sql/pglite",
  },
  useWorker: true,
});
```

In Deno, use `npm:` specifiers for worker-serializable custom providers:

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: {
    moduleSpecifier: "npm:@electric-sql/pglite@0.4.5",
  },
  useWorker: true,
});
```

---

## Common Upgrade Errors

### `PGlite provider is required`

Add `pgliteProvider: createPGliteProvider()` to `:memory:` or `file://`
connections.

### `PostgreSQL provider is required`

Add `pgProvider: createPgProvider()` to direct PostgreSQL connections and sync
connections.

### `Cannot find package '@electric-sql/pglite'`

In Node.js, install the optional peer:

```bash
npm install @electric-sql/pglite
```

### `Cannot find package 'pg'` or `pg-logical-replication`

In Node.js, install the PostgreSQL optional peers:

```bash
npm install pg pg-logical-replication
```

### Custom provider works in-process but fails in worker mode

Use `moduleSpecifier` and, for extensions, `extensionSpecifiers` instead of only
callback functions when `useWorker: true` or `syncUrl` is used.

---

## What Did Not Change

- `Ominipg.query()` and SQL parameter behavior.
- CRUD schema definitions and MongoDB-style filters.
- `withDrizzle()` usage after an `Ominipg` instance is connected.
- `schemaSQL`, `pgliteConfig`, and `pgliteExtensions` option names.
- Sync method names: `sync()` and `syncSequences()`.

---

## See Also

- [API Reference](./API.md)
- [Quick Reference](./QUICK_REFERENCE.md)
- [Sync Guide](./SYNC.md)
- [Extensions Guide](./EXTENSIONS.md)
