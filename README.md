# Standalone Edge Database Library

A powerful, self-contained library for Deno that provides a type-safe, edge-compatible database solution with optional, real-time, bidirectional synchronization. It uses PGlite for local file-based storage and can sync with any standard PostgreSQL database.

This library is designed to be run inside an Isolate, providing a robust database instance with its own dedicated worker thread.

## Key Features

-   **Flexible Database Core:** Use a local, file-based PGlite database (`file://...`) for zero-dependency edge setups or connect directly to a remote PostgreSQL server (`postgres://...`).
-   **Bidirectional Synchronization:** Optionally enable real-time, two-way data sync between the local PGlite instance and a remote PostgreSQL database.
-   **Last-Write-Wins (LWW) Conflict Resolution:** Automatically resolves data conflicts during synchronization based on a configurable timestamp column (defaults to `updated_at`).
-   **Type-Safe Queries:** Integrates with **Drizzle ORM**, allowing you to write fully type-safe SQL queries against your schema.
-   **Automatic Schema Management:**
    -   Applies your DDL statements on initialization.
    -   Ensures the remote sync database schema matches the local schema.
    -   Dynamically creates tables on the fly if they are discovered from the remote replication stream but don't exist locally.
-   **Isolated and Performant:** The entire database engine runs within its own dedicated Web Worker, preventing it from blocking the main application thread.

## Getting Started

Using the library involves two main steps: defining your schema and connecting the client.

### 1. Define Your Schema

Create one or more schema files (e.g., `db/schema.ts`). These files should export your Drizzle ORM schema definitions and an array of SQL DDL strings for table creation.

**Example `db/schema.ts`:**

```typescript
import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Drizzle schema definition for the 'users' table
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').unique(),
  active: boolean('active').default(true),
  updated_at: timestamp('updated_at').notNull().defaultNow(),
});

// SQL DDL for table creation (idempotent)
export const schemaDDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    active BOOLEAN DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // ... add other CREATE TABLE statements here
];
```

### 2. Connect the Client

In your application code, import and use `EdgeDB.connect()` to initialize the database. This function returns a fully-featured Drizzle client instance, augmented with some useful methods.

```typescript
import { EdgeDB } from './path/to/standalone-db-lib/src/client/index.ts';
import * as schema from './path/to/your/db/schema.ts';

// Database configuration
const dbConfig = {
    // The local PGlite database file path
    url: 'file:///path/to/your/local/database.db',
    
    // (Optional) The remote PostgreSQL connection string for sync
    syncUrl: 'postgresql://user:password@host:port/dbname',
    
    // The Drizzle schema object
    schema: schema,
    
    // The DDL statements for table creation
    schemaSQL: schema.schemaDDL,
};

// Connect to the database
const db = await EdgeDB.connect(dbConfig);

// You can now use 'db' as a standard Drizzle client
const allUsers = await db.select().from(schema.users);
console.log(allUsers);

// --- Custom Methods ---

// Manually trigger a push of local changes to the remote
const { pushed } = await db.sync();
console.log(`Pushed ${pushed} changes.`);

// Close the database connection and terminate the worker
await db.close();
```

## Connection Options

The `EdgeDB.connect(options)` method accepts the following properties in its options object:

| Option              | Type           | Description                                                                                             |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `url`               | `string`       | Main database URL. Use `file://` for PGlite, `postgres://` for PostgreSQL. Defaults to in-memory.        |
| `syncUrl`           | `string`       | (Optional) The remote PostgreSQL URL for bidirectional sync.                                            |
| `schema`            | `object`       | The Drizzle schema object containing your table definitions.                                            |
| `schemaSQL`         | `string[]`     | An array of SQL DDL strings for schema creation.                                                        |
| `edgeId`            | `string`       | (Optional) A unique identifier for this client instance. Helps prevent sync echoes.                     |
| `lwwColumn`         | `string`       | (Optional) The column name for Last-Write-Wins conflict resolution. Defaults to `updated_at`.           |
| `skipInitialSync`   | `boolean`      | (Optional) If true, skips the initial pull of data from the remote. Defaults to `false`.                |

## How It Works

The library is composed of two main parts:

-   **The Client (`src/client`):** This is the part you interact with in your application. It provides the Drizzle-compatible API and communicates with the worker.
-   **The Worker (`src/worker`):** This runs the actual PGlite database instance in a separate thread. It handles all SQL execution, schema management, and the complex logic for data synchronization using logical replication.

This architecture ensures that even complex database operations or network-intensive sync processes do not impact the performance of your main application code. 