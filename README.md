# Ominipg 🐘: The All-in-One PostgreSQL Toolkit for Deno

[![JSR](https://img.shields.io/badge/jsr-%40oxian%2Fominipg-blue?style=for-the-badge&logo=deno)](https://jsr.io/@oxian/ominipg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)
[![Deno 2.0+](https://img.shields.io/badge/deno-%5E2.0-brightgreen?logo=deno&style=for-the-badge)](https://deno.com)

**Ominipg is the flexible, all-in-one toolkit for PostgreSQL in Deno.** Whether
you need a simple local database, a powerful offline-first solution with
real-time sync, or just a non-blocking client for your server, Ominipg adapts to
your needs.

It runs the entire database connection in a dedicated worker, ensuring your
application remains fast and responsive, no matter the task.

---

## ✨ One Library, Many Faces

Ominipg is designed to be your go-to database client, no matter the
architecture. Pick the pattern that fits your project.

### 1. The Simple Local Database

_Perfect for scripts, local development, and standalone applications._

Get the power of PostgreSQL without running a server. Ominipg uses PGlite to
create a file-based database that's fast, reliable, and self-contained.

```typescript
const db = await Ominipg.connect({
  url: "file://./my-app.db", // Just a local file
  schemaSQL: ["CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)"],
});
// db is ready for local queries!
```

### 2. The Syncing Edge Database

_The ultimate solution for offline-first and edge applications._

Combine a local PGlite database with real-time, bidirectional synchronization to
a remote PostgreSQL server. Work seamlessly offline and sync automatically when
a connection is restored.

```typescript
const db = await Ominipg.connect({
  url: "file://./local-cache.db",
  syncUrl: Deno.env.get("REMOTE_DATABASE_URL"), // Your remote Postgres
  schemaSQL: ["CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)"],
});
// Local and remote data are now in sync!
```

### 3. The Non-Blocking Postgres Client

_A modern, performant way to connect to any standard PostgreSQL database._

Use Ominipg as a proxy to your primary database. All connections and queries run
in a background worker, preventing database operations from ever blocking your
main application thread.

```typescript
const db = await Ominipg.connect({
  url: Deno.env.get("PRIMARY_DATABASE_URL"), // Your standard Postgres
  schemaSQL: ["CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)"],
});
// Now querying your remote DB without blocking the main thread!
```

## 💡 Core Features

- 🚀 **Always Non-Blocking:** By running in a worker, Ominipg guarantees your
  main thread is always free for critical tasks.
- 🛠️ **Choose Your Architecture:** From local-only to globally synced, Ominipg
  adapts to your project's needs without changing your code.
- 🎯 **ORM-Agnostic with Built-in Drizzle Support:** Use raw SQL for maximum
  control, or the built-in `withDrizzle()` helper for type-safe queries. No
  forced dependencies.
- 🔄 **Intelligent Sync & Conflict Resolution:** For edge use cases, you get
  automatic Last-Write-Wins conflict resolution and real-time bidirectional
  sync.
- ⚙️ **Zero-Config Schema Management:** Define your schema once, and Ominipg
  handles the setup everywhere.

## 🚀 Quick Start

Ominipg is ORM-agnostic! You can use it with raw SQL or optionally with any ORM
like Drizzle.

### Raw SQL Usage (No Dependencies)

**`main.ts`**

```typescript
import { Ominipg } from "jsr:@oxian/ominipg";

const db = await Ominipg.connect({
  url: "postgres://localhost:5432/mydb",
  schemaSQL: [
    `CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      completed BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  ],
});

// Execute raw SQL queries
const todos = await db.query("SELECT * FROM todos WHERE completed = $1", [
  false,
]);
console.log(todos.rows);

// Insert data
await db.query("INSERT INTO todos (title) VALUES ($1)", ["Learn Ominipg"]);

// Sync with remote (if configured)
await db.sync();
```

### Optional Drizzle Integration

If you prefer using Drizzle ORM, you can easily integrate it using the built-in
`withDrizzle` helper:

```typescript
import { Ominipg, withDrizzle } from "jsr:@oxian/ominipg";
import { drizzle } from "npm:drizzle-orm/pg-proxy";
import * as schema from "./schema.ts";

const ominipg = await Ominipg.connect({
  url: "postgres://localhost:5432/mydb",
  schemaSQL: schema.schemaDDL,
});

// Create Drizzle adapter with explicit drizzle import
const db = withDrizzle(ominipg, drizzle, schema);

// Use Drizzle syntax + Ominipg methods
const allTodos = await db.select().from(schema.todos);
await db.sync();
```

**Schema Definition Example:**

```typescript
import { boolean, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const todos = pgTable("todos", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  completed: boolean("completed").default(false),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const schemaDDL = [
  `CREATE TABLE IF NOT EXISTS todos (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    completed BOOLEAN DEFAULT false,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
];
```

**Why use `withDrizzle`?**

- ✅ **Zero setup** - Just pass your schema and you're ready
- ✅ **Type-safe** - Full TypeScript support out of the box
- ✅ **Best of both worlds** - Drizzle syntax + Ominipg features
- ✅ **No lock-in** - Switch between raw SQL and Drizzle anytime

## 🤔 Which Approach Should I Use?

| Feature              | Raw SQL      | `withDrizzle()` Helper |
| -------------------- | ------------ | ---------------------- |
| **Setup complexity** | ⚡ Minimal   | ⚡ Minimal             |
| **Type safety**      | ❌ Manual    | ✅ Automatic           |
| **Query builder**    | ❌ Write SQL | ✅ Drizzle syntax      |
| **Performance**      | ✅ Maximum   | ✅ Excellent           |
| **Learning curve**   | ✅ Just SQL  | 📚 SQL + Drizzle       |
| **Bundle size**      | ✅ Smallest  | 📦 +Drizzle ORM        |
| **IntelliSense**     | ❌ Basic     | ✅ Full autocomplete   |

**Choose Raw SQL when:** You prefer writing SQL directly, want minimum bundle
size, or have simple query needs.

**Choose `withDrizzle()` when:** You want type safety, love autocompletion, or
are building complex applications.

## ⚡ Getting Started in 30 Seconds

**Try it with raw SQL:**

```bash
# No installation needed with Deno!
deno run --allow-net https://deno.land/x/ominipg/examples/quick-start.ts
```

**Try it with Drizzle:**

```typescript
import { Ominipg, withDrizzle } from "jsr:@oxian/ominipg";
import { drizzle } from "npm:drizzle-orm/pg-proxy";
import { pgTable, serial, text } from "npm:drizzle-orm/pg-core";

const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

const ominipg = await Ominipg.connect({
  url: ":memory:", // In-memory database
  schemaSQL: ["CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL)"],
});

const db = await withDrizzle(ominipg, drizzle, { users });
await db.insert(users).values({ name: "Alice" });
const allUsers = await db.select().from(users);
console.log(allUsers); // [{ id: 1, name: 'Alice' }]
```

## ⚙️ Connection Options

| Option            | Type       | Description                                                                                                               |
| ----------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `url`             | `string`   | Main database URL. Use `file://` for local or `postgres://` for remote. Defaults to in-memory.                            |
| `syncUrl`         | `string`   | (Optional) The remote PostgreSQL URL for enabling bidirectional sync with a local `file://` DB.                           |
| `schemaSQL`       | `string[]` | An array of SQL DDL strings for schema creation.                                                                          |
| `lwwColumn`       | `string`   | (Optional) The column for Last-Write-Wins conflict resolution. Defaults to `updated_at`.                                  |
| `disableAutoPush` | `boolean`  | (Optional) If `true`, disables automatic pushing of local changes. Use `db.sync()` to push manually. Defaults to `false`. |

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

[MIT](./LICENSE)
