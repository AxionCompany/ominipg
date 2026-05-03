# API Reference

Complete API documentation for Ominipg.

Ominipg supports Deno and Node.js 22+. The npm package is ESM-only.

In Deno, database engines are resolved from the application import map. Add the
engines you use to `deno.json`:

```json
{
  "imports": {
    "@electric-sql/pglite": "npm:@electric-sql/pglite@0.3.4",
    "pg": "npm:pg@8.16.3",
    "pg-logical-replication": "npm:pg-logical-replication@2.4.0"
  }
}
```

When using PGlite extensions in Deno, map the extension subpaths you enable, for
example:

```json
{
  "imports": {
    "@electric-sql/pglite/contrib/uuid_ossp": "npm:@electric-sql/pglite@0.3.4/contrib/uuid_ossp",
    "@electric-sql/pglite/vector": "npm:@electric-sql/pglite@0.3.4/vector"
  }
}
```

---

## Table of Contents

- [Ominipg Class](#ominipg-class)
- [Connection Options](#connection-options)
- [Query Methods](#query-methods)
- [Sync Methods](#sync-methods)
- [CRUD API](#crud-api)
- [Drizzle Integration](#drizzle-integration)
- [Events](#events)
- [Types](#types)

---

## Ominipg Class

The main class for interacting with PostgreSQL databases.

### Type imports

For Deno:

```typescript
import type {
  CrudApi,
  CrudSchemas,
  OminipgClientEvents,
  OminipgConnectionOptions,
} from "jsr:@oxian/ominipg";
import type { PgProvider } from "jsr:@oxian/ominipg/pg";
import type { PGliteProvider } from "jsr:@oxian/ominipg/pglite";
```

For Node.js:

```typescript
import type {
  CrudApi,
  CrudSchemas,
  OminipgClientEvents,
  OminipgConnectionOptions,
} from "@oxian/ominipg";
import type { PgProvider } from "@oxian/ominipg/pg";
import type { PGliteProvider } from "@oxian/ominipg/pglite";
```

### `Ominipg.connect(options)`

Creates a new database connection.

**Signature:**

```typescript
static async connect(
  options: OminipgConnectionOptions
): Promise<Ominipg>

// With CRUD schemas
static async connect<S extends CrudSchemas>(
  options: OminipgConnectionOptions & { schemas: S }
): Promise<OminipgWithCrud<S>>
```

**Parameters:**

- `options` - Connection configuration (see
  [Connection Options](#connection-options))

**Returns:**

- `Promise<Ominipg>` - Connected database instance
- `Promise<OminipgWithCrud<S>>` - Database instance with typed CRUD API when
  schemas are provided

**Example:**

```typescript
import { createPGliteProvider } from "jsr:@oxian/ominipg/pglite";

// Basic connection
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
});

// With schema
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
  schemaSQL: [`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)`],
});

// With CRUD schemas
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
  schemas: defineSchema({
    users: {
      schema: {/* JSON Schema */},
      keys: [{ property: "id" }],
    },
  }),
});
```

---

## Connection Options

### `OminipgConnectionOptions`

Configuration object for database connections.

```typescript
interface OminipgConnectionOptions {
  // Database URL
  url?: string;

  // SQL statements to initialize schema
  schemaSQL?: string[];

  // Remote database URL for syncing
  syncUrl?: string;

  // Engine providers
  pgliteProvider?: PGliteProvider;
  pgProvider?: PgProvider;

  // Force worker mode (default: auto-detect)
  useWorker?: boolean;

  // PGlite extensions to load
  pgliteExtensions?: string[];

  // Additional options forwarded to the embedded PGlite engine
  pgliteConfig?: PGliteConfig;

  // CRUD schemas definition
  schemas?: CrudSchemas;

  // Enable performance metrics logging
  logMetrics?: boolean;
}

type PGliteConfig = {
  /**
   * Refer to @electric-sql/pglite's PGliteOptions for the full list of settings.
   * Commonly used values include initialMemory, relaxedDurability, dataDir, and wasmModule.
   */
  [key: string]: unknown;
};
```

### Properties

#### `url` (optional)

- **Type:** `string`
- **Default:** `":memory:"`
- **Description:** Database connection string

**Supported formats:**

```typescript
":memory:"; // In-memory PGlite
"file://./data/app.db"; // Persistent PGlite
"postgresql://user:pass@host:port/db"; // PostgreSQL connection
"postgres://user:pass@host:port/db"; // PostgreSQL connection (alias)
```

#### `schemaSQL` (optional)

- **Type:** `string[]`
- **Description:** Array of SQL DDL statements to execute on connection

**Example:**

```typescript
schemaSQL: [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX idx_users_email ON users(email)`,
];
```

#### `syncUrl` (optional)

- **Type:** `string`
- **Description:** Remote PostgreSQL URL for syncing local changes

When provided, enables local-first mode with sync capabilities.

**Example:**

```typescript
syncUrl: "postgresql://user:pass@myserver.com:5432/prod_db";
```

#### `useWorker` (optional)

- **Type:** `boolean`
- **Default:** Auto-detected based on configuration
- **Description:** Force worker mode or direct mode

**Auto-detection rules:**

- PostgreSQL + no sync = Direct mode (best performance)
- PGlite + no sync = in-process mode by default
- Sync enabled or `useWorker: true` = Worker mode (Deno Web Worker or Node
  `worker_threads`)

In Ominipg 0.6+, PGlite without sync defaults to in-process execution unless
`useWorker: true` is provided. Sync still uses worker mode by default.

**Example:**

```typescript
useWorker: true; // Force worker mode
```

#### `pgliteExtensions` (optional)

- **Type:** `string[]`
- **Description:** PGlite extensions to load (only for PGlite databases)

**Available extensions:**

- `"uuid_ossp"` - UUID generation functions
- `"vector"` - Vector similarity search (pgvector)
- `"postgis"` - Geographic information system
- And more (see [Extensions Guide](./EXTENSIONS.md))

**Example:**

```typescript
pgliteExtensions: ["uuid_ossp", "vector"];
```

#### `pgliteConfig` (optional)

- **Type:** `PGliteConfig`
- **Description:** Fine-grained configuration for the embedded PGlite runtime
  (e.g. WASM memory limits)

**Example:**

```typescript
pgliteConfig: {
  initialMemory: 256 * 1024 * 1024,
}
```

#### `pgliteProvider` (required for PGlite URLs)

- **Type:** `PGliteProvider`
- **Description:** Loads PGlite only when a `:memory:` or `file://` connection
  is used. Import `createPGliteProvider` from `@oxian/ominipg/pglite` or
  `jsr:@oxian/ominipg/pglite`.
- **Worker mode:** Custom callback providers are supported in-process. Worker
  mode requires a provider created with module specifiers, such as the default
  `createPGliteProvider()`, because worker messages must be serializable.

#### `pgProvider` (required for PostgreSQL URLs or sync)

- **Type:** `PgProvider`
- **Description:** Loads `pg` and logical replication support only when direct
  PostgreSQL or sync features are used. Import `createPgProvider` from
  `@oxian/ominipg/pg` or `jsr:@oxian/ominipg/pg`.
- **Worker mode:** Custom callback providers are supported for direct in-process
  PostgreSQL. Sync and worker mode require serializable module specifiers, such
  as the default `createPgProvider()`.

#### `schemas` (optional)

- **Type:** `CrudSchemas`
- **Description:** JSON Schema definitions for CRUD API

See [CRUD API Guide](./CRUD.md) for details.

#### `logMetrics` (optional)

- **Type:** `boolean`
- **Default:** `false`
- **Description:** Enable memory usage logging for performance monitoring

---

## Query Methods

### `query(sql, params?)`

Execute a SQL query.

**Signature:**

```typescript
async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<{ rows: TRow[] }>
```

**Parameters:**

- `sql` - SQL query string
- `params` - Optional query parameters (uses `$1`, `$2`, etc. in SQL)

**Returns:**

- Promise resolving to `{ rows: TRow[] }`

**Example:**

```typescript
// Simple query
const result = await db.query("SELECT * FROM users");
console.log(result.rows);

// Parameterized query
const result = await db.query(
  "SELECT * FROM users WHERE age > $1 AND city = $2",
  [18, "New York"],
);

// With type parameter
interface User {
  id: number;
  name: string;
  email: string;
}

const result = await db.query<User>("SELECT * FROM users");
// result.rows is User[]
```

### `queryRaw(sql, params?)` (deprecated)

Alias for `query()`. Use `query()` instead.

---

## Sync Methods

Methods for syncing local changes with remote databases.

### `sync()`

Push local changes to the remote database.

**Signature:**

```typescript
async sync(): Promise<{ pushed: number }>
```

**Returns:**

- `{ pushed: number }` - Number of records pushed to remote

**Throws:**

- Error if called in direct PostgreSQL mode (sync not available)

**Example:**

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://...",
  pgliteProvider: createPGliteProvider(),
  pgProvider: createPgProvider(),
});

// Make local changes
await db.query("INSERT INTO users (name) VALUES ('Alice')");
await db.query("INSERT INTO users (name) VALUES ('Bob')");

// Sync to remote
const result = await db.sync();
console.log(`Pushed ${result.pushed} changes`);
```

**Events:**

- Emits `"sync:start"` when sync begins
- Emits `"sync:end"` with result when sync completes

### `syncSequences()`

Synchronize sequence values from the remote database.

**Signature:**

```typescript
async syncSequences(): Promise<{ synced: number }>
```

**Returns:**

- `{ synced: number }` - Number of sequences synchronized

**Description:** Updates local sequence values (like auto-increment IDs) from
the remote database to prevent conflicts.

**Example:**

```typescript
const result = await db.syncSequences();
console.log(`Synced ${result.synced} sequences`);
```

---

## Diagnostic Methods

### `getDiagnosticInfo()`

Get information about the database state.

**Signature:**

```typescript
async getDiagnosticInfo(): Promise<Record<string, unknown>>
```

**Returns:**

- Object containing diagnostic information

**Example:**

```typescript
const info = await db.getDiagnosticInfo();
console.log(info);
// {
//   mainDatabase: { type: "pglite" },
//   syncDatabase: { hasSyncPool: true },
//   trackedTables: ["users", "posts"],
//   ...
// }
```

---

## Lifecycle Methods

### `close()`

Close the database connection and cleanup resources.

**Signature:**

```typescript
async close(): Promise<void>
```

**Example:**

```typescript
await db.close();
```

**Events:**

- Emits `"close"` event when connection is closed

---

## CRUD API

When schemas are provided during connection, a CRUD API is automatically
generated.

**Standalone Usage:**

You can also use the CRUD module independently with any database library by
importing from `jsr:@oxian/ominipg/crud`. See the
[CRUD Guide](./CRUD.md#using-with-other-libraries) for examples with
postgres.js, node-postgres, Drizzle, and more.

```typescript
import { createCrudApi, defineSchema } from "jsr:@oxian/ominipg/crud";

const schemas = defineSchema({ users: {/* ... */} });
const crud = createCrudApi(schemas, queryFunction);
```

### Table Methods

Each table defined in schemas gets the following methods:

#### `find(filter?, options?)`

Find multiple records matching a filter.

**Signature:**

```typescript
async find(
  filter?: Filter<Row>,
  options?: FindOptions
): Promise<Row[]>
```

See [CRUD API Guide](./CRUD.md) for complete documentation.

#### `findOne(filter?)`

Find a single record.

**Signature:**

```typescript
async findOne(filter?: Filter<Row>): Promise<Row | null>
```

#### `create(data)`

Create a new record.

**Signature:**

```typescript
async create(data: InsertRow): Promise<Row>
```

#### `createMany(data)`

Create multiple records.

**Signature:**

```typescript
async createMany(data: InsertRow[]): Promise<Row[]>
```

#### `update(filter, data, options?)`

Update records matching a filter.

**Signature:**

```typescript
async update(
  filter: Filter<Row>,
  data: Partial<InsertRow>,
  options?: { upsert?: boolean }
): Promise<Row[]>
```

#### `updateMany(filter, data, options?)`

Alias for `update()`.

#### `delete(filter)`

Delete records matching a filter.

**Signature:**

```typescript
async delete(filter: Filter<Row>): Promise<{ deletedCount: number }>
```

#### `deleteMany(filter)`

Alias for `delete()`.

**Example:**

```typescript
const schemas = defineSchema({
  users: {/* schema */},
});

const db = await Ominipg.connect({
  pgliteProvider: createPGliteProvider(),
  schemas,
});

// Type inference (no imports needed!)
type User = typeof schemas.users.$inferSelect;
type NewUser = typeof schemas.users.$inferInsert;

// Find all users
const users = await db.crud.users.find();

// Find with filter
const adults = await db.crud.users.find({ age: { $gte: 18 } });

// Create user
const user = await db.crud.users.create({
  id: "1",
  name: "Alice",
  email: "alice@example.com",
});

// Update user
await db.crud.users.update(
  { id: "1" },
  { name: "Alice Smith" },
);

// Delete user
await db.crud.users.delete({ id: "1" });
```

---

## Drizzle Integration

### `withDrizzle(ominipg, drizzle, schema?)`

Create a Drizzle ORM adapter for an Ominipg instance.

**Signature:**

```typescript
function withDrizzle<TDrizzle, TSchema extends Record<string, unknown>>(
  ominipgInstance: Ominipg,
  drizzleFactory: DrizzleFactory<TDrizzle, TSchema>,
  schema?: TSchema,
): TDrizzle & OminipgDrizzleMixin;
```

**Parameters:**

- `ominipgInstance` - Connected Ominipg instance
- `drizzleFactory` - The `drizzle` function from `drizzle-orm/pg-proxy`
- `schema` - Optional Drizzle schema object

**Returns:**

- Drizzle instance with Ominipg methods added

**Added Methods:**

- `sync()` - Sync local changes
- `syncSequences()` - Sync sequences
- `getDiagnosticInfo()` - Get diagnostic info
- `close()` - Close connection
- `queryRaw(sql, params)` - Execute raw SQL
- `_ominipg` - Access underlying Ominipg instance

**Example:**

```typescript
import { Ominipg, withDrizzle } from "jsr:@oxian/ominipg";
import { createPGliteProvider } from "jsr:@oxian/ominipg/pglite";
import { drizzle } from "npm:drizzle-orm/pg-proxy";
import { pgTable, serial, text } from "npm:drizzle-orm/pg-core";

const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

const ominipg = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
});
const db = withDrizzle(ominipg, drizzle, { users });

// Use Drizzle methods
const allUsers = await db.select().from(users);

// Ominipg methods still available
await db.sync();
await db.close();
```

See [Drizzle Integration Guide](./DRIZZLE.md) for details.

---

## Events

Ominipg extends `TypedEmitter` and emits the following events:

### Event Types

```typescript
interface OminipgClientEvents {
  connected: () => void;
  close: () => void;
  error: (error: Error) => void;
  "sync:start": () => void;
  "sync:end": (result: { pushed: number }) => void;
}
```

### Listening to Events

```typescript
db.on("connected", () => {
  console.log("Database connected");
});

db.on("sync:start", () => {
  console.log("Sync started");
});

db.on("sync:end", (result) => {
  console.log(`Sync completed: ${result.pushed} changes pushed`);
});

db.on("error", (error) => {
  console.error("Database error:", error);
});

db.on("close", () => {
  console.log("Database closed");
});
```

---

## Types

### Core Types

#### `OminipgConnectionOptions`

```typescript
interface OminipgConnectionOptions {
  url?: string;
  schemaSQL?: string[];
  syncUrl?: string;
  useWorker?: boolean;
  pgliteExtensions?: string[];
  schemas?: CrudSchemas;
  logMetrics?: boolean;
}
```

#### `OminipgWithCrud<Schemas>`

```typescript
type OminipgWithCrud<Schemas extends CrudSchemas> = Ominipg & {
  crud: CrudApi<Schemas>;
};
```

#### `OminipgDrizzleMixin`

```typescript
type OminipgDrizzleMixin = {
  sync: () => Promise<{ pushed: number }>;
  syncSequences: () => Promise<{ synced: number }>;
  getDiagnosticInfo: () => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
  queryRaw: <TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: TRow[] }>;
  _ominipg: Ominipg;
};
```

### CRUD Types

**Type Inference (Recommended):**

```typescript
const schemas = defineSchema({
  users: {/* schema */},
});

type User = typeof schemas.users.$inferSelect; // Full row type
type NewUser = typeof schemas.users.$inferInsert; // Insert type
type UserKey = typeof schemas.users.$inferKey; // Key type
```

See [CRUD API Guide](./CRUD.md) for complete type documentation.

---

## Best Practices

### 1. Always Close Connections

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteProvider: createPGliteProvider(),
});
try {
  // Your code here
} finally {
  await db.close();
}
```

### 2. Use Parameterized Queries

```typescript
// ✅ Good - prevents SQL injection
await db.query("SELECT * FROM users WHERE id = $1", [userId]);

// ❌ Bad - SQL injection vulnerability
await db.query(`SELECT * FROM users WHERE id = ${userId}`);
```

### 3. Handle Errors

```typescript
try {
  await db.query("SELECT * FROM users");
} catch (error) {
  console.error("Query failed:", error);
}

// Or use events
db.on("error", (error) => {
  console.error("Database error:", error);
});
```

### 4. Choose the Right Mode

```typescript
// For PostgreSQL without sync - use direct mode (faster)
const db = await Ominipg.connect({
  url: "postgresql://...",
  pgProvider: createPgProvider(),
  useWorker: false,
});

// For local-first sync - use worker mode (default)
const db = await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://...",
  pgliteProvider: createPGliteProvider(),
  pgProvider: createPgProvider(),
  // useWorker: true is default
});
```

---

## See Also

- [0.6 Migration Guide](./MIGRATION_0_6.md)
- [CRUD API Guide](./CRUD.md)
- [Drizzle Integration](./DRIZZLE.md)
- [Sync Guide](./SYNC.md)
- [Extensions](./EXTENSIONS.md)
- [Architecture](./ARCHITECTURE.md)
