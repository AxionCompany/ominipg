# Drizzle ORM Integration

Use Ominipg with Drizzle ORM for fully type-safe database operations.

---

## Table of Contents

- [Why Drizzle?](#why-drizzle)
- [Setup](#setup)
- [Basic Usage](#basic-usage)
- [Schema Definition](#schema-definition)
- [Queries](#queries)
- [Migrations](#migrations)
- [Combining with CRUD API](#combining-with-crud-api)
- [Advanced Usage](#advanced-usage)

---

## Why Drizzle?

Drizzle ORM provides:

- ✅ **Full type safety** - TypeScript types inferred from schema
- ✅ **SQL-like syntax** - Feels like writing SQL, not learning a new DSL
- ✅ **Zero runtime overhead** - Compiles to raw SQL
- ✅ **Great DX** - Autocomplete and type checking everywhere
- ✅ **Flexible** - Drop down to raw SQL when needed

**Ominipg + Drizzle** = Best of both worlds:
- Drizzle's type safety and query builder
- Ominipg's local-first sync and worker isolation

---

## Setup

### Installation

```typescript
// Import Ominipg
import { Ominipg, withDrizzle } from "jsr:@oxian/ominipg";

// Import Drizzle
import { drizzle } from "npm:drizzle-orm/pg-proxy";
import { pgTable, serial, text, integer, timestamp } from "npm:drizzle-orm/pg-core";
```

### Define Schema

Define your schema using Drizzle's schema builder:

```typescript
import { pgTable, serial, text, varchar, timestamp, boolean } from "npm:drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  age: integer("age"),
  createdAt: timestamp("created_at").defaultNow()
});

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  authorId: integer("author_id").references(() => users.id),
  title: text("title").notNull(),
  body: text("body").notNull(),
  published: boolean("published").default(false),
  createdAt: timestamp("created_at").defaultNow()
});

// Export schema for type inference
export const schema = { users, posts };
```

### Connect

```typescript
// 1. Create Ominipg instance
const ominipg = await Ominipg.connect({
  url: ":memory:",
  schemaSQL: [
    `CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      age INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE posts (
      id SERIAL PRIMARY KEY,
      author_id INTEGER REFERENCES users(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      published BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`
  ]
});

// 2. Create Drizzle adapter
const db = withDrizzle(ominipg, drizzle, schema);

// Now you have a fully typed Drizzle instance!
```

---

## Basic Usage

### Insert

```typescript
// Insert single record
const user = await db.insert(users).values({
  name: "Alice",
  email: "alice@example.com",
  age: 25
}).returning();

console.log(user[0].id); // Auto-generated ID

// Insert multiple records
await db.insert(users).values([
  { name: "Bob", email: "bob@example.com", age: 30 },
  { name: "Charlie", email: "charlie@example.com", age: 35 }
]);
```

### Select

```typescript
// Select all users
const allUsers = await db.select().from(users);

// Select specific columns
const names = await db.select({
  id: users.id,
  name: users.name
}).from(users);

// With conditions
import { eq, gt, and, or } from "npm:drizzle-orm";

const adults = await db.select()
  .from(users)
  .where(gt(users.age, 18));

const specific = await db.select()
  .from(users)
  .where(eq(users.id, 1));
```

### Update

```typescript
// Update with condition
await db.update(users)
  .set({ age: 26 })
  .where(eq(users.id, 1));

// Update multiple fields
await db.update(users)
  .set({ 
    name: "Alice Smith",
    age: 26 
  })
  .where(eq(users.id, 1));

// Update with returning
const updated = await db.update(users)
  .set({ age: 26 })
  .where(eq(users.id, 1))
  .returning();
```

### Delete

```typescript
// Delete with condition
await db.delete(users)
  .where(eq(users.id, 1));

// Delete multiple
await db.delete(users)
  .where(gt(users.age, 65));
```

---

## Schema Definition

### Column Types

```typescript
import { 
  pgTable,
  serial, integer, bigint, real, doublePrecision,
  varchar, text, char,
  boolean,
  date, timestamp, time,
  json, jsonb,
  uuid
} from "npm:drizzle-orm/pg-core";

export const products = pgTable("products", {
  // Numeric types
  id: serial("id").primaryKey(),
  quantity: integer("quantity"),
  price: real("price"),
  totalValue: doublePrecision("total_value"),
  
  // String types
  name: varchar("name", { length: 255 }),
  description: text("description"),
  code: char("code", { length: 10 }),
  
  // Boolean
  inStock: boolean("in_stock").default(true),
  
  // Date/Time
  releaseDate: date("release_date"),
  createdAt: timestamp("created_at").defaultNow(),
  processingTime: time("processing_time"),
  
  // JSON
  metadata: json("metadata"),
  settings: jsonb("settings"),
  
  // UUID
  externalId: uuid("external_id")
});
```

### Constraints

```typescript
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  
  // NOT NULL
  name: text("name").notNull(),
  
  // UNIQUE
  email: text("email").unique(),
  
  // DEFAULT
  status: text("status").default("active"),
  createdAt: timestamp("created_at").defaultNow(),
  
  // CHECK (via database)
  age: integer("age") // Add CHECK in schemaSQL
});
```

### Relations

```typescript
import { relations } from "npm:drizzle-orm";

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts)
}));

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, {
    fields: [posts.authorId],
    references: [users.id]
  })
}));
```

---

## Queries

### Filtering

```typescript
import { eq, ne, gt, gte, lt, lte, isNull, isNotNull, inArray, notInArray, like, ilike } from "npm:drizzle-orm";

// Comparison operators
await db.select().from(users).where(eq(users.age, 25));
await db.select().from(users).where(ne(users.status, "deleted"));
await db.select().from(users).where(gt(users.age, 18));
await db.select().from(users).where(gte(users.age, 18));

// NULL checks
await db.select().from(users).where(isNull(users.deletedAt));
await db.select().from(users).where(isNotNull(users.email));

// Array operations
await db.select().from(users)
  .where(inArray(users.id, [1, 2, 3]));

// String operations
await db.select().from(users)
  .where(like(users.name, "A%"));
  
await db.select().from(users)
  .where(ilike(users.email, "%@gmail.com"));
```

### Logical Operators

```typescript
import { and, or, not } from "npm:drizzle-orm";

// AND
await db.select().from(users)
  .where(and(
    gt(users.age, 18),
    eq(users.status, "active")
  ));

// OR
await db.select().from(users)
  .where(or(
    eq(users.role, "admin"),
    eq(users.role, "moderator")
  ));

// NOT
await db.select().from(users)
  .where(not(eq(users.status, "deleted")));

// Complex conditions
await db.select().from(users)
  .where(and(
    or(
      eq(users.role, "admin"),
      eq(users.role, "moderator")
    ),
    gt(users.age, 18)
  ));
```

### Joins

```typescript
// Inner join
const results = await db.select()
  .from(posts)
  .innerJoin(users, eq(posts.authorId, users.id));

// Left join
const results = await db.select()
  .from(posts)
  .leftJoin(users, eq(posts.authorId, users.id));

// Custom select with joins
const results = await db.select({
  postId: posts.id,
  postTitle: posts.title,
  authorName: users.name
})
.from(posts)
.leftJoin(users, eq(posts.authorId, users.id));
```

### Ordering & Limiting

```typescript
import { asc, desc } from "npm:drizzle-orm";

// Order by
await db.select().from(users)
  .orderBy(asc(users.name));

await db.select().from(users)
  .orderBy(desc(users.createdAt));

// Multiple order by
await db.select().from(users)
  .orderBy(asc(users.age), desc(users.name));

// Limit & Offset
await db.select().from(users)
  .limit(10)
  .offset(0);

// Pagination
const page = 2;
const pageSize = 10;
await db.select().from(users)
  .limit(pageSize)
  .offset((page - 1) * pageSize);
```

### Aggregations

```typescript
import { count, sum, avg, min, max } from "npm:drizzle-orm";

// Count
const result = await db.select({ 
  count: count() 
}).from(users);

// Count with condition
const result = await db.select({ 
  count: count() 
})
.from(users)
.where(gt(users.age, 18));

// Other aggregations
const stats = await db.select({
  total: count(),
  avgAge: avg(users.age),
  minAge: min(users.age),
  maxAge: max(users.age)
}).from(users);

// Group by
const statsByRole = await db.select({
  role: users.role,
  count: count()
})
.from(users)
.groupBy(users.role);
```

### Subqueries

```typescript
// Subquery in WHERE
const activeUserIds = db.select({ id: users.id })
  .from(users)
  .where(eq(users.status, "active"));

const activePosts = await db.select()
  .from(posts)
  .where(inArray(posts.authorId, activeUserIds));
```

---

## Migrations

### Generate DDL from Schema

You can use Drizzle Kit to generate SQL migrations:

```bash
# Install Drizzle Kit
deno install -A npm:drizzle-kit

# Generate migration
drizzle-kit generate:pg
```

### Apply Migrations

Use the generated SQL in Ominipg's `schemaSQL`:

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  schemaSQL: [
    // Paste generated SQL here
    `CREATE TABLE users (...)`
  ]
});
```

### Manual Migrations

```typescript
// Run migrations manually
await ominipg.query(`
  CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

// Check if migration was applied
const exists = await ominipg.query(`
  SELECT * FROM migrations WHERE name = $1
`, ["add_users_table"]);

if (exists.rows.length === 0) {
  // Apply migration
  await ominipg.query(`CREATE TABLE users (...)`);
  
  // Record migration
  await ominipg.query(`
    INSERT INTO migrations (name) VALUES ($1)
  `, ["add_users_table"]);
}
```

---

## Combining with CRUD API

You can use both Drizzle and CRUD API in the same application:

```typescript
import { defineSchema } from "jsr:@oxian/ominipg";

// Define CRUD schemas
const crudSchemas = defineSchema({
  categories: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" }
      }
    },
    keys: [{ property: "id" }]
  }
});

// Connect with CRUD schemas
const ominipg = await Ominipg.connect({
  url: ":memory:",
  schemas: crudSchemas,
  schemaSQL: [/* ... */]
});

// Create Drizzle adapter
const db = withDrizzle(ominipg, drizzle, drizzleSchema);

// Use Drizzle for complex queries
const posts = await db.select()
  .from(postsTable)
  .innerJoin(usersTable, eq(postsTable.authorId, usersTable.id))
  .where(gt(usersTable.age, 18));

// Use CRUD API for simple operations
const category = await ominipg.crud.categories.create({
  id: "tech",
  name: "Technology"
});

// Both use the same underlying connection!
```

---

## Advanced Usage

### Transactions

```typescript
// Note: Drizzle transactions are not yet supported in pg-proxy mode
// Use raw SQL for transactions

await db.queryRaw("BEGIN");
try {
  await db.insert(users).values({ name: "Alice" });
  await db.insert(posts).values({ title: "Post 1" });
  await db.queryRaw("COMMIT");
} catch (error) {
  await db.queryRaw("ROLLBACK");
  throw error;
}
```

### Prepared Statements

```typescript
// Drizzle automatically uses parameterized queries
const getUserById = (id: number) => 
  db.select().from(users).where(eq(users.id, id));

const user1 = await getUserById(1);
const user2 = await getUserById(2);
```

### Custom SQL

```typescript
import { sql } from "npm:drizzle-orm";

// Custom SQL expressions
await db.select({
  id: users.id,
  upperName: sql`UPPER(${users.name})`
}).from(users);

// Custom WHERE clause
await db.select()
  .from(users)
  .where(sql`${users.age} > 18 AND ${users.status} = 'active'`);

// Raw SQL fallback
const results = await db.queryRaw(`
  SELECT * FROM users WHERE age > $1
`, [18]);
```

### Type Inference

```typescript
// Infer types from schema
type User = typeof users.$inferSelect;
type NewUser = typeof users.$inferInsert;

// Infer from query results
const query = db.select({
  id: users.id,
  name: users.name
}).from(users);

type QueryResult = Awaited<typeof query>[number];
// QueryResult = { id: number; name: string }
```

---

## Performance Tips

### 1. Select Only Needed Columns

```typescript
// ✅ Good - only select needed columns
const names = await db.select({
  id: users.id,
  name: users.name
}).from(users);

// ❌ Less efficient - selects all columns
const users = await db.select().from(users);
```

### 2. Use Indexes

```typescript
// Create indexes for frequently queried columns
schemaSQL: [
  `CREATE INDEX idx_users_email ON users(email)`,
  `CREATE INDEX idx_posts_author_id ON posts(author_id)`,
  `CREATE INDEX idx_posts_created_at ON posts(created_at)`
]
```

### 3. Batch Operations

```typescript
// ✅ Good - single query
await db.insert(users).values([
  { name: "Alice" },
  { name: "Bob" },
  { name: "Charlie" }
]);

// ❌ Slow - multiple queries
for (const user of users) {
  await db.insert(users).values(user);
}
```

### 4. Avoid N+1 Queries

```typescript
// ❌ N+1 query problem
const posts = await db.select().from(postsTable);
for (const post of posts) {
  const author = await db.select()
    .from(usersTable)
    .where(eq(usersTable.id, post.authorId));
}

// ✅ Single query with join
const postsWithAuthors = await db.select()
  .from(postsTable)
  .leftJoin(usersTable, eq(postsTable.authorId, usersTable.id));
```

---

## Complete Example

```typescript
import { Ominipg, withDrizzle } from "jsr:@oxian/ominipg";
import { drizzle } from "npm:drizzle-orm/pg-proxy";
import { pgTable, serial, text, integer, timestamp, boolean } from "npm:drizzle-orm/pg-core";
import { eq, gt, and, desc } from "npm:drizzle-orm";

// 1. Define schema
const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  age: integer("age"),
  createdAt: timestamp("created_at").defaultNow()
});

const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  authorId: integer("author_id").references(() => users.id),
  title: text("title").notNull(),
  body: text("body").notNull(),
  published: boolean("published").default(false),
  createdAt: timestamp("created_at").defaultNow()
});

const schema = { users, posts };

// 2. Connect
const ominipg = await Ominipg.connect({
  url: ":memory:",
  schemaSQL: [
    `CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      age INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE posts (
      id SERIAL PRIMARY KEY,
      author_id INTEGER REFERENCES users(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      published BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`
  ]
});

const db = withDrizzle(ominipg, drizzle, schema);

// 3. Insert data
const [user] = await db.insert(users).values({
  name: "Alice",
  email: "alice@example.com",
  age: 25
}).returning();

await db.insert(posts).values([
  {
    authorId: user.id,
    title: "Hello World",
    body: "My first post!",
    published: true
  },
  {
    authorId: user.id,
    title: "Drizzle is Great",
    body: "I love type safety!",
    published: true
  }
]);

// 4. Query with joins
const publishedPosts = await db.select({
  postId: posts.id,
  postTitle: posts.title,
  authorName: users.name,
  authorEmail: users.email
})
.from(posts)
.innerJoin(users, eq(posts.authorId, users.id))
.where(eq(posts.published, true))
.orderBy(desc(posts.createdAt));

console.log(publishedPosts);

// 5. Update
await db.update(posts)
  .set({ title: "Hello World (Updated)" })
  .where(eq(posts.id, 1));

// 6. Sync (if using remote database)
// await db.sync();

// 7. Close
await db.close();
```

---

## See Also

- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [API Reference](./API.md)
- [CRUD API Guide](./CRUD.md)
- [Examples](../examples/with-drizzle-simple.ts)

