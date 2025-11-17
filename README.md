# Ominipg

> **The flexible, all-in-one toolkit for PostgreSQL in Deno**

[![JSR](https://jsr.io/badges/@oxian/ominipg)](https://jsr.io/@oxian/ominipg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Ominipg is a flexible PostgreSQL toolkit for Deno that combines the power of [PGlite](https://github.com/electric-sql/pglite) (PostgreSQL in WASM) with a modern, developer-friendly API. Build local-first applications, use powerful CRUD operations with MongoDB-style filters, or integrate with your favorite ORM—all with full TypeScript type safety.

---

## ✨ Features

- 🦕 **Deno Native**: Built specifically for Deno runtime (Node.js/Bun/Browser support [planned](./ROADMAP.md))
- 🚀 **Multiple Modes**: In-memory, persistent, or direct PostgreSQL connections
- 🔄 **Local-First Sync**: Automatic synchronization between local and remote databases
- 📝 **Powerful CRUD API**: MongoDB-style filters with full type inference
- 🎯 **ORM Integration**: Works seamlessly with Drizzle ORM
- 🔌 **Standalone or Integrated**: Use CRUD module with any PostgreSQL database library
- ⚡ **Worker Isolation**: Run database operations in a Web Worker
- 🔧 **PostgreSQL Extensions**: Support for uuid_ossp, vector, and more
- 📘 **TypeScript First**: Complete type safety and inference
- 🪶 **Lightweight**: Zero-config for simple use cases

---

## 📦 Installation

```typescript
// Full library
import { Ominipg } from "jsr:@oxian/ominipg";

// CRUD module only (use with any database library)
import { defineSchema, createCrudApi } from "jsr:@oxian/ominipg/crud";
```

---

## 🚀 Quick Start

### In-Memory Database with Raw SQL

```typescript
import { Ominipg } from "jsr:@oxian/ominipg";

// Create an in-memory database
const db = await Ominipg.connect({
  url: ":memory:",
  schemaSQL: [`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE
    )
  `],
});

// Execute queries
await db.query("INSERT INTO users (name, email) VALUES ($1, $2)", [
  "Alice",
  "alice@example.com",
]);

const result = await db.query("SELECT * FROM users");
console.log(result.rows);

await db.close();
```

### CRUD API with Type Safety

```typescript
import { Ominipg, defineSchema } from "jsr:@oxian/ominipg";

// Define schema with full type inference
const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        age: { type: "number" },
      },
      required: ["id", "name", "email"],
    },
    keys: [{ property: "id" }],
    timestamps: true, // Automatic createdAt/updatedAt
  },
});

const db = await Ominipg.connect({
  url: ":memory:",
  schemas,
});

// Type-safe CRUD operations
const user = await db.crud.users.create({
  id: "1",
  name: "Alice",
  email: "alice@example.com",
  age: 30,
});

// MongoDB-style filters
const adults = await db.crud.users.find({
  age: { $gte: 18 },
  email: { $like: "%@example.com" },
});

// Pagination and sorting
const page1 = await db.crud.users.find(
  {},
  { limit: 10, skip: 0, sort: { createdAt: "desc" } }
);
```

### Local-First with Sync

```typescript
const db = await Ominipg.connect({
  url: ":memory:", // Local database
  syncUrl: "postgresql://user:pass@host:5432/db", // Remote sync
  schemaSQL: [`CREATE TABLE users (...)`],
});

// Work locally (instant, no network)
await db.query("INSERT INTO users ...");
await db.query("UPDATE users ...");

// Sync to remote when ready
const result = await db.sync();
console.log(`Pushed ${result.pushed} changes to remote`);
```

### Drizzle ORM Integration

```typescript
import { Ominipg, withDrizzle } from "jsr:@oxian/ominipg";
import { drizzle } from "npm:drizzle-orm/pg-proxy";
import { pgTable, serial, text } from "npm:drizzle-orm/pg-core";
import { eq } from "npm:drizzle-orm";

const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

const ominipg = await Ominipg.connect({ url: ":memory:" });
const db = await withDrizzle(ominipg, drizzle, { users });

// Use Drizzle's API
await db.insert(users).values({ name: "Alice" });
const allUsers = await db.select().from(users);
```

---

## 🎯 Use Cases

### 1. Local-First Deno Applications

Build offline-capable Deno applications with persistent storage that sync when connected:

```typescript
const db = await Ominipg.connect({
  url: "file://./data/app.db", // Persistent local storage
  syncUrl: Deno.env.get("REMOTE_DB_URL"),
});

// App works offline
await db.crud.todos.create({ title: "Buy milk", done: false });

// Sync when online
db.on("sync:end", (result) => {
  console.log(`Synced ${result.pushed} changes`);
});
await db.sync();
```

> **Note:** Cross-runtime support (Node.js, Bun, Browser) is planned. See [ROADMAP.md](./ROADMAP.md) for details.

### 2. Rapid Prototyping with Type Safety

Get a full CRUD API with validation in seconds:

```typescript
const schemas = defineSchema({
  posts: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        authorId: { type: "string" },
      },
      required: ["id", "title", "authorId"],
    },
    keys: [{ property: "id" }],
    timestamps: true,
  },
});

const db = await Ominipg.connect({ url: ":memory:", schemas });

// Fully typed CRUD operations ready to use
await db.crud.posts.create({ ... });
const posts = await db.crud.posts.find({ authorId: "123" });
```

### 3. Testing with In-Memory Database

Perfect for unit tests with instant setup/teardown:

```typescript
Deno.test("user registration", async () => {
  const db = await Ominipg.connect({
    url: ":memory:",
    schemas: userSchemas,
  });

  const user = await db.crud.users.create({
    id: "1",
    email: "test@example.com",
  });

  assertEquals(user.email, "test@example.com");

  await db.close(); // Clean up
});
```

### 4. Standalone CRUD with Existing Database

Use the CRUD module with any database library:

```typescript
import { defineSchema, createCrudApi } from "jsr:@oxian/ominipg/crud";
import postgres from "npm:postgres";

const sql = postgres(DATABASE_URL);

// Create query adapter
async function queryFn(sql: string, params?: unknown[]) {
  const result = await sql.unsafe(sql, params);
  return { rows: result };
}

// Get type-safe CRUD API
const schemas = defineSchema({ users: { ... } });
const crud = createCrudApi(schemas, queryFn);

// Use with your existing database
const users = await crud.users.find({ age: { $gte: 18 } });
```

---

## 📚 Core Concepts

### Connection Modes

| Mode | URL | Use Case |
|------|-----|----------|
| **In-Memory** | `:memory:` | Testing, prototyping, temporary data |
| **Persistent** | `file://./data.db` | Local storage, offline-first apps |
| **Direct PostgreSQL** | `postgresql://...` | Direct connection to PostgreSQL server |
| **Worker Mode** | Any + `useWorker: true` | Isolate DB operations in Web Worker |

### CRUD API Filters

Ominipg supports MongoDB-style query operators:

```typescript
// Comparison operators
{ age: 25 }                      // Equals
{ age: { $ne: 25 } }            // Not equals
{ age: { $gt: 18, $lt: 65 } }   // Greater than, less than
{ age: { $gte: 18 } }           // Greater than or equal
{ age: { $lte: 65 } }           // Less than or equal

// Array operators
{ status: { $in: ["active", "pending"] } }
{ status: { $nin: ["deleted"] } }

// String operators
{ name: { $like: "A%" } }        // Starts with A
{ email: { $ilike: "%gmail%" } }  // Contains gmail (case-insensitive)

// Null checks
{ deletedAt: null }              // IS NULL
{ deletedAt: { $ne: null } }     // IS NOT NULL

// Logical operators
{ $and: [{ age: { $gte: 18 } }, { verified: true }] }
{ $or: [{ role: "admin" }, { role: "moderator" }] }
{ $not: { status: "banned" } }
```

### Type Inference

Schemas automatically infer TypeScript types:

```typescript
const schemas = defineSchema({
  users: {
    schema: { /* ... */ },
    keys: [{ property: "id" }],
  },
});

// Automatic type inference - no imports needed!
type User = typeof schemas.users.$inferSelect;
type NewUser = typeof schemas.users.$inferInsert;

// Use with functions
async function getUser(id: string): Promise<User> {
  return await db.crud.users.findOne({ id });
}
```

---

## 🔧 Configuration Options

```typescript
await Ominipg.connect({
  // Database connection
  url: ":memory:",                           // Required
  syncUrl: "postgresql://...",               // Optional remote sync

  // Schema and initialization
  schemas: defineSchema({ ... }),            // CRUD schemas
  schemaSQL: ["CREATE TABLE ..."],           // DDL statements

  // PGlite extensions
  pgliteExtensions: ["uuid_ossp", "vector"], // Extensions to load
  pgliteConfig: {
    initialMemory: 256 * 1024 * 1024,        // WASM memory limit
  },

  // Worker mode
  useWorker: true,                           // Run in Web Worker

  // Direct mode (PostgreSQL)
  poolConfig: {
    max: 10,                                 // Connection pool size
    idleTimeoutMillis: 30000,
  },
});
```

---

## 🎨 API Overview

### Core Database API

```typescript
// Execute raw SQL
const result = await db.query(sql, params);

// Sync with remote
const syncResult = await db.sync();
await db.syncSequences();

// Events
db.on("connected", () => console.log("Connected"));
db.on("sync:end", (result) => console.log("Synced"));
db.on("error", (error) => console.error(error));

// Diagnostic info
const info = await db.getDiagnosticInfo();

// Cleanup
await db.close();
```

### CRUD API

```typescript
// Create operations
await db.crud.users.create(data);
await db.crud.users.createMany([data1, data2]);

// Read operations
await db.crud.users.find(filter, options);
await db.crud.users.findOne(filter);

// Update operations
await db.crud.users.update(filter, updates);
await db.crud.users.update(filter, data, { upsert: true });

// Delete operations
await db.crud.users.delete(filter);
```

---

## 📖 Documentation

Explore detailed guides and examples:

- **[Quick Reference](./docs/QUICK_REFERENCE.md)** - Fast lookup for common operations
- **[CRUD Guide](./docs/CRUD.md)** - Complete guide to the CRUD API
- **[Sync Guide](./docs/SYNC.md)** - Local-first and synchronization
- **[Drizzle Integration](./docs/DRIZZLE.md)** - Using Ominipg with Drizzle ORM
- **[API Reference](./docs/API.md)** - Full API documentation
- **[Architecture](./docs/ARCHITECTURE.md)** - How Ominipg works under the hood
- **[Extensions](./docs/EXTENSIONS.md)** - PostgreSQL extensions support

### Examples

Check out the `/examples` directory for complete, runnable examples:

- [`quick-start.ts`](./examples/quick-start.ts) - Basic usage
- [`with-drizzle-simple.ts`](./examples/with-drizzle-simple.ts) - Drizzle ORM integration
- [`crud-standalone.ts`](./examples/crud-standalone.ts) - CRUD module with other libraries
- [`pglite-extensions.ts`](./examples/pglite-extensions.ts) - Using PostgreSQL extensions

---

## 🛠️ Development

### Prerequisites

- **Deno** 2.x or higher
- **PostgreSQL** (optional, for testing remote features)

### Running Tests

```bash
# Run all tests
deno test --allow-all

# Run specific test
deno test --allow-all test/crud.test.ts

# With watch mode
deno test --allow-all --watch
```

### Running Examples

```bash
deno run --allow-all examples/quick-start.ts
deno run --allow-all examples/with-drizzle-simple.ts
```

---

## 🗺️ Roadmap

We're actively working on expanding Ominipg. See [ROADMAP.md](./ROADMAP.md) for details:

- 🌐 **Cross-Runtime Support** - Node.js, Bun, and Browser compatibility
- 🔄 **Bi-directional Sync** - Two-way synchronization with conflict resolution
- 🗄️ **Pluggable Storage** - SQLite and other backend support
- 🔤 **Column Aliases** - Map snake_case columns to camelCase in TypeScript

---

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

Areas we'd love help with:

- 🐛 Bug fixes and edge case handling
- 📚 Documentation improvements
- ✅ Test coverage expansion
- 🚀 Performance optimizations
- 🎨 Real-world examples

---

## 📄 License

MIT License - see [LICENSE](./LICENSE) for details.

---

## 🙏 Acknowledgments

Ominipg is built on the shoulders of giants:

- **[PGlite](https://github.com/electric-sql/pglite)** - PostgreSQL in WASM
- **[pg](https://node-postgres.com/)** - PostgreSQL client for Node.js
- **[Drizzle ORM](https://orm.drizzle.team/)** - TypeScript ORM integration
- **[Zod](https://zod.dev/)** - Schema validation

---

## 📞 Support

- 📖 **Documentation**: [./docs](./docs)
- 🐛 **Issues**: [GitHub Issues](https://github.com/AxionCompany/ominipg/issues)
- 💬 **Discussions**: [GitHub Discussions](https://github.com/AxionCompany/ominipg/discussions)

---

<div align="center">

**Made with ❤️ by the Ominipg Team**

[⭐ Star us on GitHub](https://github.com/AxionCompany/ominipg) | [📦 View on JSR](https://jsr.io/@oxian/ominipg)

</div>

