# Ominipg

> The flexible, all-in-one PostgreSQL toolkit for Deno

**Ominipg** is a modern PostgreSQL client for Deno that brings the best of both worlds: the power of PostgreSQL with the simplicity of local-first development. Run in-memory databases with PGlite or connect to real PostgreSQL instances, all with the same intuitive API.

[![JSR](https://jsr.io/badges/@oxian/ominipg)](https://jsr.io/@oxian/ominipg)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Deno](https://img.shields.io/badge/deno-%5E1.40-blue?logo=deno)](https://deno.land)

---

## ✨ Why Ominipg?

If you've used **Mongoose** for MongoDB, you'll feel right at home. Ominipg brings that same developer-friendly experience to PostgreSQL, with powerful features for modern applications:

| Feature | Description |
|---------|-------------|
| 🚀 **Zero Config** | Works out of the box with in-memory databases or PostgreSQL |
| 🔄 **Local-First Ready** | Built-in sync between local PGlite and remote PostgreSQL |
| 🎨 **Multiple APIs** | Choose between raw SQL, Drizzle ORM, or Mongoose-style CRUD |
| ⚡ **Performance Modes** | Worker-based isolation or direct mode for maximum speed |
| 🧪 **Testing Made Easy** | In-memory databases perfect for tests - no setup required |
| 🔌 **Extensions Support** | Use PGlite extensions like vector search, UUID generation |
| 📦 **Type-Safe** | Full TypeScript support with schema inference |

### Compared to Other Solutions

```typescript
// ❌ Traditional PostgreSQL clients
// - Complex setup for local development
// - No built-in sync capabilities
// - Limited type safety without ORMs

// ❌ Heavy ORMs (Prisma, TypeORM)
// - Large dependencies and build steps
// - Code generation required
// - Less flexibility for raw SQL

// ✅ Ominipg
// - Works immediately with :memory: databases
// - Built-in sync for local-first apps
// - Choose your API style (SQL, ORM, or CRUD)
// - Lightweight and flexible
```

---

## 🚀 Quick Start (30 seconds)

```typescript
import { Ominipg } from "jsr:@oxian/ominipg";

// 1. Connect to an in-memory database
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

// 2. Insert data
await db.query(
  "INSERT INTO users (name, email) VALUES ($1, $2)",
  ["Alice", "alice@example.com"]
);

// 3. Query data
const users = await db.query("SELECT * FROM users");
console.log(users.rows); // [{ id: 1, name: "Alice", email: "alice@example.com" }]

await db.close();
```

**That's it!** No PostgreSQL installation needed. Perfect for development and testing.

[Try it now →](https://dash.deno.com/playground/ominipg-quickstart) | [See more examples →](./examples)

---

## 📦 Installation

### Using JSR (Recommended)

```typescript
// Full library
import { Ominipg } from "jsr:@oxian/ominipg";

// CRUD module only (use with any database library)
import { defineSchema, createCrudApi } from "jsr:@oxian/ominipg/crud";
```

### Using Deno

```bash
deno add @oxian/ominipg
```

### Permissions

Ominipg needs the following permissions:

```bash
# For development (all permissions)
deno run --allow-all your-app.ts

# For production (minimal permissions)
deno run --allow-net --allow-read --allow-write --allow-env your-app.ts
```

---

## 🎯 Core Features

### 1. Multiple Database Modes

```typescript
// In-memory database (PGlite) - perfect for development/testing
const localDb = await Ominipg.connect({ url: ":memory:" });

// PostgreSQL connection - production ready
const remoteDb = await Ominipg.connect({ 
  url: "postgresql://user:pass@localhost:5432/mydb" 
});

// Local-first with sync - best of both worlds
const syncDb = await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://user:pass@localhost:5432/mydb"
});
```

### 2. Flexible Query Styles

Choose the API that fits your needs:

#### Raw SQL (Full Control)

```typescript
const users = await db.query(
  "SELECT * FROM users WHERE age > $1",
  [18]
);
```

#### Drizzle ORM (Type-Safe)

```typescript
import { withDrizzle } from "jsr:@oxian/ominipg";
import { drizzle } from "npm:drizzle-orm/pg-proxy";

const db = withDrizzle(ominipg, drizzle, schema);

// Fully typed queries
const youngUsers = await db.select()
  .from(users)
  .where(lt(users.age, 30));
```

[Learn more about Drizzle integration →](./docs/DRIZZLE.md)

#### CRUD Helpers (Mongoose-Style)

```typescript
import { Ominipg, defineSchema } from "jsr:@oxian/ominipg";

const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        age: { type: "number" },
        status: { type: "string" }
      },
      required: ["id", "name", "email"]
    },
    keys: [{ property: "id" }],
    timestamps: true, // Auto-manage created_at/updated_at
    defaults: {
      status: "active",
      id: () => crypto.randomUUID()
    }
  }
});

const db = await Ominipg.connect({
  url: ":memory:",
  schemas
});

// Type inference - no imports needed!
type User = typeof schemas.users.$inferSelect;
type NewUser = typeof schemas.users.$inferInsert;

// MongoDB-like API
const user = await db.crud.users.create({
  id: "1",
  name: "Alice",
  email: "alice@example.com",
  age: 25
});

- `default` fills in any missing insert fields. Static values and factory functions are allowed; the factory runs once per row. Defaulted fields participate in the INSERT clause but are skipped from the UPDATE clause of an upsert, so existing records are not overwritten.
- Properties marked with JSON Schema `format: "date-time"` or `format: "date"` surface as `Date` in the inferred types (while still accepting strings at runtime), letting you opt into richer typing without extra boilerplate.

// Powerful filters
const adults = await db.crud.users.find({
  age: { $gte: 18 }
});

// Relations and populate
const posts = await db.crud.posts.find(
  { published: true },
  { populate: ["author", "tags"] }
);
```

**Use CRUD with Other Libraries:**

The CRUD module works standalone with any database library:

```typescript
import { defineSchema, createCrudApi } from "jsr:@oxian/ominipg/crud";
import { Pool } from "npm:pg";

const pool = new Pool({ connectionString: "postgresql://..." });

const schemas = defineSchema({
  users: { /* schema */ }
});

// Create CRUD API with your own query function
const crud = createCrudApi(schemas, async (sql, params) => {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params ?? []);
    return { rows: result.rows };
  } finally {
    client.release();
  }
});

// Use it!
const users = await crud.users.find({ age: { $gte: 18 } });
```

[Learn more about CRUD API →](./docs/CRUD.md)

### 3. Local-First Sync

Build offline-capable apps with automatic sync:

```typescript
const db = await Ominipg.connect({
  url: ":memory:", // Local PGlite database
  syncUrl: "postgresql://...", // Remote PostgreSQL
  schemaSQL: [/* your schema */]
});

// Work offline - all data stored locally
await db.crud.users.create({ name: "Alice" });
await db.crud.posts.create({ title: "Hello World" });

// Sync when ready
const result = await db.sync();
console.log(`Synced ${result.pushed} changes`);
```

[Learn more about sync →](./docs/SYNC.md)

### 4. PGlite Extensions

Enhance your local database with powerful extensions:

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteExtensions: ["uuid_ossp", "vector"], // Load extensions
  pgliteConfig: {
    initialMemory: 256 * 1024 * 1024, // 256 MB for larger embeddings
  },
  schemaSQL: [`
    CREATE TABLE products (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name TEXT,
      embedding VECTOR(384)
    )
  `]
});

// Use vector similarity search
const similar = await db.query(`
  SELECT * FROM products
  ORDER BY embedding <=> $1::vector
  LIMIT 5
`, [searchVector]);
```

[Learn more about extensions →](./docs/EXTENSIONS.md)

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Your Application                    │
└───────────────────┬─────────────────────────────────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │   Ominipg Client      │
        │  - query()            │
        │  - crud.*             │
        │  - sync()             │
        └───────┬───────────────┘
                │
        ┌───────┴──────────┐
        │                  │
        ▼                  ▼
┌──────────────┐   ┌──────────────┐
│ Worker Mode  │   │ Direct Mode  │
│ (Isolated)   │   │ (Fast)       │
└──────┬───────┘   └──────┬───────┘
       │                  │
       ▼                  ▼
┌──────────────┐   ┌──────────────┐
│   PGlite     │   │ PostgreSQL   │
│ (In-Memory)  │   │  (Remote)    │
└──────────────┘   └──────────────┘
       │                  │
       └────────┬─────────┘
                │
                ▼ (Optional Sync)
        ┌──────────────┐
        │ Remote DB    │
        │ (PostgreSQL) │
        └──────────────┘
```

**Worker Mode** (default): Runs database operations in a Web Worker for isolation and performance.

**Direct Mode**: Connects directly to PostgreSQL for maximum speed (automatically used when connecting to PostgreSQL without sync).

[Learn more about architecture →](./docs/ARCHITECTURE.md)

---

## 📖 Documentation

### Guides
- [API Reference](./docs/API.md) - Complete API documentation
- [CRUD API Guide](./docs/CRUD.md) - Mongoose-style CRUD operations
- [Drizzle Integration](./docs/DRIZZLE.md) - Type-safe ORM queries
- [Sync Guide](./docs/SYNC.md) - Local-first sync strategies
- [Extensions](./docs/EXTENSIONS.md) - Using PGlite extensions
- [Architecture](./docs/ARCHITECTURE.md) - How Ominipg works internally

### Examples
- [Quick Start](./examples/quick-start.ts) - Get started in 30 seconds
- [Drizzle ORM](./examples/with-drizzle-simple.ts) - Type-safe queries
- [Standalone CRUD](./examples/crud-standalone.ts) - Use CRUD module with any database library
- [PGlite Extensions](./examples/pglite-extensions.ts) - UUID, Vector search, etc.

---

## 🎓 Common Use Cases

### Local Development & Testing

```typescript
// Perfect for tests - no setup, super fast
const db = await Ominipg.connect({ url: ":memory:" });
```

### Local-First Applications

```typescript
// Build offline-capable apps
const db = await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://..." // Sync when online
});
```

### Edge Computing

```typescript
// Run PostgreSQL at the edge with Deno Deploy
const db = await Ominipg.connect({
  url: "postgresql://..." // Connect to your database
});
```

### Type-Safe Development

```typescript
// Use with Drizzle for full type safety
const db = withDrizzle(ominipg, drizzle, schema);
```

---

## 🗺️ Roadmap

We're working on exciting features:

- ✅ **CRUD API** - Mongoose-style helpers (v0.3.0)
- 🚧 **Cross-Runtime Support** - Node.js, Bun, Browser support
- 📊 **Connection Pooling** - Advanced connection management

[See full roadmap →](./ROADMAP.md)

---

## 🤝 Contributing

We welcome contributions! Here's how to get started:

```bash
# Clone the repository
git clone https://github.com/AxionCompany/ominipg.git
cd ominipg

# Run tests
deno test --allow-all

# Run examples
deno run --allow-all examples/quick-start.ts
```

Please read our [Contributing Guide](./CONTRIBUTING.md) for details on our code of conduct and development process.

---

## 📄 License

MIT License - see [LICENSE](./LICENSE) for details.

---

## 🙏 Acknowledgments

Ominipg is built on top of amazing open-source projects:

- [PGlite](https://github.com/electric-sql/pglite) - PostgreSQL in WebAssembly
- [node-postgres](https://node-postgres.com/) - PostgreSQL client for Node.js
- [Drizzle ORM](https://orm.drizzle.team/) - TypeScript ORM

---

<div align="center">

**[Documentation](./docs/API.md)** • **[Examples](./examples)** • **[GitHub](https://github.com/AxionCompany/ominipg)** • **[Issues](https://github.com/AxionCompany/ominipg/issues)**

Made with ❤️ by the Ominipg team

</div>
