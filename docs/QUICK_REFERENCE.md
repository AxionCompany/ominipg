# Quick Reference

Fast lookup for common Ominipg operations.

---

## Installation

```typescript
// Full library
import { Ominipg } from "jsr:@oxian/ominipg";

// CRUD module only (use with any database library)
import { defineSchema, createCrudApi } from "jsr:@oxian/ominipg/crud";
```

---

## Connection

```typescript
// In-memory database
const db = await Ominipg.connect({ url: ":memory:" });

// PostgreSQL
const db = await Ominipg.connect({ 
  url: "postgresql://user:pass@host:5432/db" 
});

// With sync
const db = await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://user:pass@host:5432/db"
});

// With schema
const db = await Ominipg.connect({
  url: ":memory:",
  schemaSQL: [`CREATE TABLE users (...)`]
});

// With extensions
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteExtensions: ["uuid_ossp", "vector"]
});

// With custom WASM memory limits
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteConfig: {
    initialMemory: 256 * 1024 * 1024,
  }
});
```

---

## Raw SQL

```typescript
// Query
const result = await db.query("SELECT * FROM users");
console.log(result.rows);

// With parameters
const result = await db.query(
  "SELECT * FROM users WHERE age > $1",
  [18]
);

// Insert
await db.query(
  "INSERT INTO users (name, email) VALUES ($1, $2)",
  ["Alice", "alice@example.com"]
);

// Update
await db.query(
  "UPDATE users SET name = $1 WHERE id = $2",
  ["Bob", 1]
);

// Delete
await db.query("DELETE FROM users WHERE id = $1", [1]);
```

---

## CRUD API

### Setup

```typescript
import { defineSchema } from "jsr:@oxian/ominipg";

const db = await Ominipg.connect({
  url: ":memory:",
  schemas: defineSchema({
    users: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          email: { type: "string" },
          age: { type: "number" }
        },
        required: ["id", "name", "email"]
      },
      keys: [{ property: "id" }],
      timestamps: true
    }
  })
});
```

### Operations

```typescript
// Create
const user = await db.crud.users.create({
  id: "1",
  name: "Alice",
  email: "alice@example.com",
  age: 25
});

// Create many
const users = await db.crud.users.createMany([
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" }
]);

// Find all
const all = await db.crud.users.find();

// Find with filter
const adults = await db.crud.users.find({ age: { $gte: 18 } });

// Find one
const user = await db.crud.users.findOne({ id: "1" });

// Update
const updated = await db.crud.users.update(
  { id: "1" },
  { age: 26 }
);

// Upsert
const user = await db.crud.users.update(
  { id: "1" },
  { id: "1", name: "Alice", email: "alice@example.com" },
  { upsert: true }
);

// Delete
await db.crud.users.delete({ id: "1" });
```

### Standalone CRUD (with other libraries)

```typescript
import { defineSchema, createCrudApi } from "jsr:@oxian/ominipg/crud";

// Define schemas
const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string" }
      },
      required: ["id", "name", "email"]
    },
    keys: [{ property: "id" }]
  }
});

// Type inference
type User = typeof schemas.users.$inferSelect;
type NewUser = typeof schemas.users.$inferInsert;

// Create query function (use any database library)
async function queryFn(sql: string, params?: unknown[]) {
  // postgres.js, pg, Deno.postgres, etc.
  const result = await yourDb.query(sql, params);
  return { rows: result.rows };
}

// Create CRUD API
const crud = createCrudApi(schemas, queryFn);

// Use it!
const users = await crud.users.find({ name: { $like: "A%" } });
```

### Filters

```typescript
// Comparison
{ age: 25 }                    // age = 25
{ age: { $eq: 25 } }          // age = 25
{ age: { $ne: 25 } }          // age != 25
{ age: { $gt: 18 } }          // age > 18
{ age: { $gte: 18 } }         // age >= 18
{ age: { $lt: 65 } }          // age < 65
{ age: { $lte: 65 } }         // age <= 65

// Arrays
{ status: { $in: ["active", "pending"] } }
{ status: { $nin: ["deleted"] } }

// String
{ name: { $like: "A%" } }      // Starts with A
{ email: { $ilike: "%gmail%" } } // Contains gmail (case-insensitive)

// Null
{ deletedAt: null }            // IS NULL
{ deletedAt: { $ne: null } }  // IS NOT NULL
{ deletedAt: { $exists: false } } // IS NULL

// Logical
{ $and: [{ age: { $gte: 18 } }, { status: "active" }] }
{ $or: [{ role: "admin" }, { role: "moderator" }] }
{ $not: { status: "deleted" } }

// Combined
{
  age: { $gte: 18, $lt: 65 },
  status: { $in: ["active", "pending"] },
  email: { $like: "%@company.com" }
}
```

### Options

```typescript
// Limit & skip
await db.crud.users.find({}, { limit: 10, skip: 0 });

// Sort
await db.crud.users.find({}, { sort: { age: "desc" } });

// Select fields
await db.crud.users.find({}, { select: ["id", "name"] });

// Populate relations
await db.crud.posts.find({}, { populate: ["author", "tags"] });
```

---

## Drizzle ORM

```typescript
import { withDrizzle } from "jsr:@oxian/ominipg";
import { drizzle } from "npm:drizzle-orm/pg-proxy";
import { pgTable, serial, text } from "npm:drizzle-orm/pg-core";
import { eq, gt } from "npm:drizzle-orm";

// Define schema
const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  age: integer("age")
});

// Connect
const ominipg = await Ominipg.connect({ url: ":memory:" });
const db = withDrizzle(ominipg, drizzle, { users });

// Insert
await db.insert(users).values({ name: "Alice", age: 25 });

// Select
const all = await db.select().from(users);
const adults = await db.select().from(users).where(gt(users.age, 18));

// Update
await db.update(users).set({ age: 26 }).where(eq(users.id, 1));

// Delete
await db.delete(users).where(eq(users.id, 1));

// Join
const results = await db.select()
  .from(posts)
  .leftJoin(users, eq(posts.authorId, users.id));
```

---

## Sync

```typescript
// Setup
const db = await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://user:pass@host:5432/db"
});

// Make local changes
await db.query("INSERT INTO users ...");
await db.query("UPDATE users ...");

// Sync to remote
const result = await db.sync();
console.log(`Pushed ${result.pushed} changes`);

// Sync sequences
await db.syncSequences();

// Events
db.on("sync:start", () => console.log("Syncing..."));
db.on("sync:end", (r) => console.log(`Done: ${r.pushed}`));
```

---

## Extensions

```typescript
// Load extensions
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteExtensions: ["uuid_ossp", "vector"]
});

// UUID
const id = await db.query("SELECT uuid_generate_v4()");

// Vector
await db.query(`
  CREATE TABLE docs (
    id SERIAL PRIMARY KEY,
    embedding VECTOR(384)
  )
`);

await db.query(
  "INSERT INTO docs (embedding) VALUES ($1::vector)",
  ["[0.1, 0.2, ...]"]
);

const similar = await db.query(`
  SELECT * FROM docs
  ORDER BY embedding <=> $1::vector
  LIMIT 5
`, [searchVector]);
```

---

## Events

```typescript
db.on("connected", () => console.log("Connected"));
db.on("error", (error) => console.error(error));
db.on("sync:start", () => console.log("Sync started"));
db.on("sync:end", (result) => console.log("Sync completed"));
db.on("close", () => console.log("Closed"));
```

---

## Cleanup

```typescript
await db.close();
```

---

## Common Patterns

### Pagination

```typescript
const page = 1;
const pageSize = 10;

const users = await db.crud.users.find(
  {},
  {
    limit: pageSize,
    skip: (page - 1) * pageSize,
    sort: { createdAt: "desc" }
  }
);
```

### Search

```typescript
const searchTerm = "alice";

const results = await db.crud.users.find({
  $or: [
    { name: { $ilike: `%${searchTerm}%` } },
    { email: { $ilike: `%${searchTerm}%` } }
  ]
});
```

### Upsert

```typescript
await db.crud.users.update(
  { email: "alice@example.com" },
  {
    email: "alice@example.com",
    name: "Alice",
    age: 25
  },
  { upsert: true }
);
```

### Soft Delete

```typescript
// Mark as deleted
await db.crud.users.update(
  { id: "1" },
  { deletedAt: new Date().toISOString() }
);

// Find non-deleted
const active = await db.crud.users.find({
  deletedAt: { $exists: false }
});
```

### Transactions (Raw SQL)

```typescript
await db.query("BEGIN");
try {
  await db.query("INSERT INTO users ...");
  await db.query("INSERT INTO profiles ...");
  await db.query("COMMIT");
} catch (error) {
  await db.query("ROLLBACK");
  throw error;
}
```

---

## Type Inference

```typescript
const schemas = defineSchema({
  users: {
    schema: { /* ... */ },
    keys: [{ property: "id" }]
  }
});

type User = typeof schemas.users.$inferSelect;
type NewUser = typeof schemas.users.$inferInsert;
type UserKey = typeof schemas.users.$inferKey;
```

---

## See Also

- [Full API Reference](./API.md)
- [CRUD Guide](./CRUD.md)
- [Drizzle Integration](./DRIZZLE.md)
- [Sync Guide](./SYNC.md)

