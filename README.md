# Ominipg 🐘: The All-in-One PostgreSQL Toolkit for Deno

[![JSR](https://img.shields.io/badge/jsr-%40oxian%2Fominipg-blue?style=for-the-badge&logo=deno)](https://jsr.io/@oxian/ominipg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)
[![Deno 2.0+](https://img.shields.io/badge/deno-%5E2.0-brightgreen?logo=deno&style=for-the-badge)](https://deno.com)

**Ominipg is the flexible, all-in-one toolkit for PostgreSQL in Deno.** Whether you need a simple local database, a powerful offline-first solution with real-time sync, or just a non-blocking client for your server, Ominipg adapts to your needs.

It runs the entire database connection in a dedicated worker, ensuring your application remains fast and responsive, no matter the task.

---

## ✨ One Library, Many Faces

Ominipg is designed to be your go-to database client, no matter the architecture. Pick the pattern that fits your project.

### 1. The Simple Local Database
*Perfect for scripts, local development, and standalone applications.*

Get the power of PostgreSQL without running a server. Ominipg uses PGlite to create a file-based database that's fast, reliable, and self-contained.

```typescript
const db = await Ominipg.connect({
  url: 'file://./my-app.db', // Just a local file
  schema: schema,
  schemaSQL: schema.schemaDDL,
});
// db is ready for local queries!
```

### 2. The Syncing Edge Database
*The ultimate solution for offline-first and edge applications.*

Combine a local PGlite database with real-time, bidirectional synchronization to a remote PostgreSQL server. Work seamlessly offline and sync automatically when a connection is restored.

```typescript
const db = await Ominipg.connect({
  url: 'file://./local-cache.db',
  syncUrl: Deno.env.get('REMOTE_DATABASE_URL'), // Your remote Postgres
  schema: schema,
  schemaSQL: schema.schemaDDL,
});
// Local and remote data are now in sync!
```

### 3. The Non-Blocking Postgres Client
*A modern, performant way to connect to any standard PostgreSQL database.*

Use Ominipg as a proxy to your primary database. All connections and queries run in a background worker, preventing database operations from ever blocking your main application thread.

```typescript
const db = await Ominipg.connect({
  url: Deno.env.get('PRIMARY_DATABASE_URL'), // Your standard Postgres
  schema: schema,
  schemaSQL: schema.schemaDDL,
});
// Now querying your remote DB without blocking the main thread!
```

## 💡 Core Features

-   🚀 **Always Non-Blocking:** By running in a worker, Ominipg guarantees your main thread is always free for critical tasks.
-   🛠️ **Choose Your Architecture:** From local-only to globally synced, Ominipg adapts to your project's needs without changing your code.
-   🔒 **Fully Type-Safe with Drizzle:** Write queries with confidence. End-to-end type safety means you catch errors at compile time, not in production.
-   🔄 **Intelligent Sync & Conflict Resolution:** For edge use cases, you get automatic Last-Write-Wins conflict resolution and real-time bidirectional sync.
-   ⚙️ **Zero-Config Schema Management:** Define your schema once with Drizzle, and Ominipg handles the setup everywhere.


## 🚀 Quick Start

Define your schema using Drizzle ORM, then pass it to `Ominipg.connect()` with the URL for your chosen architecture.

**`schema.ts`**
```typescript
import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Define your table with Drizzle
export const todos = pgTable('todos', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  completed: boolean('completed').default(false),
  updated_at: timestamp('updated_at').defaultNow(),
});

// Create a matching SQL statement for table creation
export const schemaDDL = [
  `CREATE TABLE IF NOT EXISTS todos (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    completed BOOLEAN DEFAULT false,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
];
```

**`main.ts`**
```typescript
import { Ominipg } from 'jsr:@oxian/ominipg'; // Replace with your import path
import * as schema from './schema.ts';

// See "One Library, Many Faces" above for url/syncUrl examples
const db = await Ominipg.connect({ /* ...your options... */ });

// You can now use 'db' just like any other Drizzle client.
const allTodos = await db.select().from(schema.todos);
console.log(allTodos);
```

## ⚙️ Connection Options

| Option              | Type           | Description                                                                                             |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `url`               | `string`       | Main database URL. Use `file://` for local or `postgres://` for remote. Defaults to in-memory.          |
| `syncUrl`           | `string`       | (Optional) The remote PostgreSQL URL for enabling bidirectional sync with a local `file://` DB.         |
| `schema`            | `object`       | The Drizzle schema object containing your table definitions.                                            |
| `schemaSQL`         | `string[]`     | An array of SQL DDL strings for schema creation.                                                        |
| `lwwColumn`         | `string`       | (Optional) The column for Last-Write-Wins conflict resolution. Defaults to `updated_at`.              |
| `disableAutoPush`   | `boolean`      | (Optional) If `true`, disables automatic pushing of local changes. Use `db.sync()` to push manually. Defaults to `false`. |

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

[MIT](./LICENSE) 