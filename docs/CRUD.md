# CRUD API Guide

A Mongoose-style API for PostgreSQL with schema validation, type safety, and powerful query filters.

---

## Table of Contents

- [Overview](#overview)
- [Defining Schemas](#defining-schemas)
- [Type Inference](#type-inference)
- [Creating Records](#creating-records)
- [Finding Records](#finding-records)
- [Query Filters](#query-filters)
- [Updating Records](#updating-records)
- [Deleting Records](#deleting-records)
- [Relations & Populate](#relations--populate)
- [Timestamps](#timestamps)
- [Validation](#validation)
- [Advanced Usage](#advanced-usage)
- [Using with Other Libraries](#using-with-other-libraries)
- [Performance Tips](#performance-tips)
- [Complete Example](#complete-example)

---

## Overview

The CRUD API provides a familiar, MongoDB-like interface for PostgreSQL operations. If you've used Mongoose, you'll feel right at home.

**Key Features:**
- 📝 JSON Schema-based validation
- 🔍 MongoDB-style query filters
- 🔗 Relations with populate support
- ⏰ Automatic timestamp management
- ✅ Runtime validation with Zod
- 📘 Full TypeScript type inference

---

## Defining Schemas

Use the `defineSchema()` helper to define your table schemas with type safety.

### Basic Schema

**With Ominipg (Recommended):**

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
        age: { type: "number" }
      },
      required: ["id", "name", "email"]
    },
    keys: [{ property: "id" }]
  }
});

const db = await Ominipg.connect({
  url: ":memory:",
  schemas,
  schemaSQL: [`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      age INTEGER
    )
  `]
});

// Now you have db.crud.users with full type safety!
```

**Standalone with Other Libraries:**

You can also import the CRUD module separately and use it with any database library:

```typescript
import { defineSchema, createCrudApi } from "jsr:@oxian/ominipg/crud";

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

// Use with any database library that supports parameterized queries
async function queryFn(sql: string, params?: unknown[]) {
  // Your database query implementation
  // Could be postgres.js, node-postgres, Deno.postgres, etc.
  const result = await yourDb.query(sql, params);
  return { rows: result.rows };
}

// Create CRUD API
const crud = createCrudApi(schemas, queryFn);

// Use it!
const user = await crud.users.create({
  id: "1",
  name: "Alice",
  email: "alice@example.com"
});

// Type inference still works
type User = typeof schemas.users.$inferSelect;
type NewUser = typeof schemas.users.$inferInsert;
```

See [Using with Other Libraries](#using-with-other-libraries) for more examples.

### Schema Configuration

```typescript
interface TableSchemaConfig {
  // JSON Schema definition
  schema: JsonSchema;
  
  // Primary key definition
  keys: Array<{ property: string }>;
  
  // Enable automatic timestamps
  timestamps?: boolean | {
    createdAt?: string;  // Column name (default: "created_at")
    updatedAt?: string;  // Column name (default: "updated_at")
  };

  // Optional defaults for missing insert fields (static values or factories)
  defaults?: Record<string, unknown | (() => unknown)>;
}
```

- JSON Schema `format` hints are respected: `format: "date-time"` or `format: "date"` on a string property will surface as a `Date` in the generated TypeScript types (while the runtime continues to accept ISO strings).
- Schema-level `default` values (inside `properties`) also make the corresponding insert property optional, matching database-supplied defaults.

### With Timestamps

```typescript
const schemas = defineSchema({
  posts: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        created_at: { type: "string" },
        updated_at: { type: "string" }
      },
      required: ["id", "title", "body"]
    },
    keys: [{ property: "id" }],
    timestamps: true // Auto-manage created_at and updated_at
  }
});
```

### Composite Keys

```typescript
const schemas = defineSchema({
  user_roles: {
    schema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        roleId: { type: "string" }
      },
      required: ["userId", "roleId"]
    },
    keys: [
      { property: "userId" },
      { property: "roleId" }
    ]
  }
});
```

---

## Type Inference

The CRUD API automatically infers TypeScript types from your schemas.

### Using `$inferSelect` and `$inferInsert` (Recommended)

The easiest way to infer types - no imports needed!

```typescript
const schemas = defineSchema({
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
    keys: [{ property: "id" }]
  }
});

// Infer the full row type (what you get back from queries)
type User = typeof schemas.users.$inferSelect;
// User = { id: string; name: string; email: string; age?: number }

// Infer the insert type (what you pass to create)
type NewUser = typeof schemas.users.$inferInsert;
// NewUser = { id: string; name: string; email: string; age?: number }
// (excludes read-only fields and auto-generated timestamps)

// Use the types
const user: User = await db.crud.users.findOne({ id: "1" });

const newUser: NewUser = {
  id: "2",
  name: "Bob",
  email: "bob@example.com"
};
await db.crud.users.create(newUser);
```

### Using Utility Types (Alternative)

You can also use utility types if you prefer:

```typescript
import type { CrudRow, InferRow, InferKey } from "jsr:@oxian/ominipg";

// Infer the full row type
type User = CrudRow<typeof schemas, "users">;

// Infer insert type
type UserInsert = InferRow<typeof schemas, "users", "insert">;

// Infer key type
type UserKey = InferKey<typeof schemas, "users">;
// For single key: string
// For composite: { userId: string; roleId: string }
```

---

## Creating Records

### `create(data)`

Create a single record.

```typescript
const user = await db.crud.users.create({
  id: "1",
  name: "Alice",
  email: "alice@example.com",
  age: 25
});

console.log(user);
// { id: "1", name: "Alice", email: "alice@example.com", age: 25 }
```

**Validation:**
- Validates against the schema
- Throws error if required fields are missing
- Throws error if data doesn't match schema types

### `createMany(data)`

Create multiple records efficiently.

```typescript
const users = await db.crud.users.createMany([
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
  { id: "3", name: "Charlie", email: "charlie@example.com" }
]);

console.log(users.length); // 3
```

**Features:**
- Batch insert for better performance
- All-or-nothing transaction (all succeed or all fail)
- Returns all created records

---

## Finding Records

### `find(filter?, options?)`

Find multiple records matching a filter.

```typescript
// Find all users
const allUsers = await db.crud.users.find();

// Find with filter
const adults = await db.crud.users.find({
  age: { $gte: 18 }
});

// Find with multiple conditions
const results = await db.crud.users.find({
  age: { $gte: 18, $lt: 65 },
  name: { $like: "A%" }
});
```

**Options:**

```typescript
interface FindOptions {
  // Populate related records
  populate?: string[];
  
  // Limit results
  limit?: number;
  
  // Skip records (for pagination)
  skip?: number;
  
  // Sort order
  sort?: Record<string, "asc" | "desc">;
  
  // Select specific fields
  select?: string[];
}
```

**Example with options:**

```typescript
const users = await db.crud.users.find(
  { age: { $gte: 18 } },
  {
    limit: 10,
    skip: 0,
    sort: { name: "asc" },
    select: ["id", "name", "email"]
  }
);
```

### `findOne(filter?)`

Find a single record (returns first match).

```typescript
const user = await db.crud.users.findOne({ id: "1" });

if (user) {
  console.log(user.name);
} else {
  console.log("User not found");
}
```

**Returns:**
- The matching record or `null` if not found

---

## Query Filters

Ominipg supports MongoDB-style query operators for powerful filtering.

### Comparison Operators

```typescript
// Equal
{ age: 25 }
{ age: { $eq: 25 } }

// Not equal
{ age: { $ne: 25 } }

// Greater than
{ age: { $gt: 18 } }

// Greater than or equal
{ age: { $gte: 18 } }

// Less than
{ age: { $lt: 65 } }

// Less than or equal
{ age: { $lte: 65 } }

// In array
{ status: { $in: ["active", "pending"] } }

// Not in array
{ status: { $nin: ["deleted", "banned"] } }
```

### String Operators

```typescript
// SQL LIKE
{ name: { $like: "A%" } }        // Starts with A
{ email: { $like: "%@gmail.com" } } // Ends with @gmail.com

// Case-insensitive LIKE (ILIKE)
{ name: { $ilike: "alice" } }

// Regular expression (PostgreSQL regex)
{ name: { $regex: "^[A-Z]" } }
```

### Logical Operators

```typescript
// AND (implicit)
{
  age: { $gte: 18 },
  status: "active"
}

// AND (explicit)
{
  $and: [
    { age: { $gte: 18 } },
    { status: "active" }
  ]
}

// OR
{
  $or: [
    { age: { $lt: 18 } },
    { age: { $gte: 65 } }
  ]
}

// NOT
{
  $not: { status: "deleted" }
}
```

### Null Checks

```typescript
// Is null
{ middleName: { $eq: null } }
{ middleName: null }

// Is not null
{ middleName: { $ne: null } }

// Exists (not null)
{ middleName: { $exists: true } }

// Does not exist (is null)
{ middleName: { $exists: false } }
```

### Nested Field Queries

For JSONB columns:

```typescript
// Query nested object properties
{
  "metadata.category.primary": "Technology"
}

// With operators
{
  "metadata.rating": { $gte: 4.5 }
}
```

### Complex Example

```typescript
const results = await db.crud.users.find({
  $or: [
    {
      $and: [
        { age: { $gte: 18, $lt: 65 } },
        { status: "active" }
      ]
    },
    {
      role: { $in: ["admin", "moderator"] }
    }
  ],
  email: { $like: "%@company.com" },
  deletedAt: { $exists: false }
});
```

---

## Updating Records

### `update(filter, data, options?)`

Update records matching a filter.

```typescript
// Update single field
const updated = await db.crud.users.update(
  { id: "1" },
  { name: "Alice Smith" }
);

// Update multiple fields
const updated = await db.crud.users.update(
  { status: "pending" },
  { 
    status: "active",
    activatedAt: new Date().toISOString()
  }
);
```

**Options:**

```typescript
interface UpdateOptions {
  // Insert if not exists
  upsert?: boolean;
}
```

**Upsert example:**

```typescript
// Update if exists, insert if not
const user = await db.crud.users.update(
  { id: "1" },
  { 
    id: "1",
    name: "Alice",
    email: "alice@example.com"
  },
  { upsert: true }
);
```

**Timestamps:**
- If `timestamps: true`, `updated_at` is automatically set
- `created_at` is preserved on updates
- On upsert, `created_at` is set for new records

**Returns:**
- Array of updated records

### `updateMany(filter, data, options?)`

Alias for `update()`. Both methods update all matching records.

```typescript
// Updates all matching records
const updated = await db.crud.users.updateMany(
  { status: "trial" },
  { status: "active" }
);

console.log(`Updated ${updated.length} users`);
```

---

## Deleting Records

### `delete(filter)`

Delete records matching a filter.

```typescript
// Delete by ID
const result = await db.crud.users.delete({ id: "1" });
console.log(result.deletedCount); // 1

// Delete multiple
const result = await db.crud.users.delete({
  status: "inactive",
  lastLoginAt: { $lt: "2023-01-01" }
});
console.log(`Deleted ${result.deletedCount} users`);
```

**Returns:**
- `{ deletedCount: number }`

**Warning:** Be careful with filters! An empty filter deletes ALL records:

```typescript
// ⚠️ Deletes ALL users
await db.crud.users.delete({});

// Better: always have a condition
await db.crud.users.delete({ status: "deleted" });
```

### `deleteMany(filter)`

Alias for `delete()`.

```typescript
const result = await db.crud.users.deleteMany({ status: "spam" });
```

---

## Relations & Populate

Define relationships between tables and populate related data.

### Defining Relations

Use `$ref` in your schema to reference other tables:

```typescript
const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" }
      },
      required: ["id", "name"]
    },
    keys: [{ property: "id" }]
  },
  
  posts: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        authorId: { 
          $ref: "#/$defs/users/properties/id" 
        },
        // Virtual field for populated data
        author: {
          readOnly: true,
          anyOf: [
            { $ref: "#/$defs/users" },
            { type: "null" }
          ]
        }
      },
      required: ["id", "title", "authorId"]
    },
    keys: [{ property: "id" }]
  }
});
```

### BelongsTo Relation

A post belongs to a user:

```typescript
const post = await db.crud.posts.findOne(
  { id: "1" },
  { populate: ["author"] }
);

console.log(post.author.name); // Populated user data
```

### HasMany Relation

Define the inverse relationship:

```typescript
const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        // Virtual field
        posts: {
          readOnly: true,
          type: "array",
          items: { $ref: "#/$defs/posts" }
        }
      }
    },
    keys: [{ property: "id" }]
  },
  
  posts: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        authorId: { $ref: "#/$defs/users/properties/id" }
      }
    },
    keys: [{ property: "id" }]
  }
});

const user = await db.crud.users.findOne(
  { id: "1" },
  { populate: ["posts"] }
);

console.log(user.posts); // Array of posts by this user
```

### ManyToMany Relation

Use a junction table:

```typescript
const schemas = defineSchema({
  posts: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        tags: {
          readOnly: true,
          type: "array",
          items: { $ref: "#/$defs/tags" }
        }
      }
    },
    keys: [{ property: "id" }]
  },
  
  tags: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        label: { type: "string" }
      }
    },
    keys: [{ property: "id" }]
  },
  
  posts_tags: {
    schema: {
      type: "object",
      properties: {
        postId: { $ref: "#/$defs/posts/properties/id" },
        tagId: { $ref: "#/$defs/tags/properties/id" }
      }
    },
    keys: [
      { property: "postId" },
      { property: "tagId" }
    ]
  }
});

const post = await db.crud.posts.findOne(
  { id: "1" },
  { populate: ["tags"] }
);

console.log(post.tags); // Array of tags for this post
```

### Nested Population

```typescript
const post = await db.crud.posts.findOne(
  { id: "1" },
  { populate: ["author", "tags"] }
);

// post.author is populated
// post.tags is populated
```

---

## Timestamps

Automatically manage `created_at` and `updated_at` fields.

### Enable Timestamps

```typescript
const schemas = defineSchema({
  posts: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        created_at: { type: "string" },
        updated_at: { type: "string" }
      }
    },
    keys: [{ property: "id" }],
    timestamps: true
  }
});
```

### Defaults

```typescript
const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        email: { type: "string" },
        status: { type: "string" },
        created_at: { type: "string" }
      },
      required: ["email"]
    },
    keys: [{ property: "id" }],
    timestamps: true,
    defaults: {
      id: () => crypto.randomUUID(),
      status: "active"
    }
  }
});
```

- Defaults run per row for `create`, `createMany`, and the INSERT half of `upsert`. Provide explicit values to override them.
- Dynamic factories execute locally; continue to prefer database-level defaults if you need decisions enforced server-side.

### Custom Column Names

```typescript
timestamps: {
  createdAt: "createdDate",
  updatedAt: "modifiedDate"
}
```

### Behavior

- **On create:** Both timestamps are set to current time
- **On update:** Only `updated_at` is changed
- **On upsert (insert):** Both timestamps are set
- **On upsert (update):** Only `updated_at` is changed

---

## Validation

All CRUD operations validate data against your JSON Schema.

### Schema Validation

```typescript
const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        email: { 
          type: "string",
          format: "email"
        },
        age: { 
          type: "number",
          minimum: 0,
          maximum: 150
        }
      },
      required: ["id", "email"]
    },
    keys: [{ property: "id" }]
  }
});

// ✅ Valid
await db.crud.users.create({
  id: "1",
  email: "alice@example.com",
  age: 25
});

// ❌ Throws error: missing required field
await db.crud.users.create({
  id: "1"
  // Missing email
});

// ❌ Throws error: age out of range
await db.crud.users.create({
  id: "1",
  email: "alice@example.com",
  age: 200
});
```

### Read-Only Fields

Mark fields as `readOnly` to prevent them from being inserted/updated:

```typescript
schema: {
  properties: {
    id: { type: "string" },
    createdAt: { 
      type: "string",
      readOnly: true 
    }
  }
}
```

### Type Coercion

Ominipg automatically converts compatible types:

```typescript
// String to number
await db.crud.users.create({
  age: "25" // Converted to 25
});

// Number to string
await db.crud.posts.create({
  id: 123 // Converted to "123"
});
```

---

## Advanced Usage

### Working with JSONB

```typescript
const schemas = defineSchema({
  posts: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        metadata: {
          type: "object",
          properties: {
            views: { type: "number" },
            tags: { 
              type: "array",
              items: { type: "string" }
            }
          }
        }
      }
    },
    keys: [{ property: "id" }]
  }
});

// Create with nested object
await db.crud.posts.create({
  id: "1",
  metadata: {
    views: 0,
    tags: ["javascript", "deno"]
  }
});

// Query nested fields
const posts = await db.crud.posts.find({
  "metadata.views": { $gte: 100 }
});

// Update nested fields
await db.crud.posts.update(
  { id: "1" },
  { 
    metadata: {
      views: 150,
      tags: ["javascript", "deno", "postgresql"]
    }
  }
);
```

### Combining with Raw SQL

You can mix CRUD operations with raw SQL:

```typescript
// Use CRUD for simple operations
const user = await db.crud.users.findOne({ id: "1" });

// Use raw SQL for complex queries
const stats = await db.query(`
  SELECT 
    users.name,
    COUNT(posts.id) as post_count
  FROM users
  LEFT JOIN posts ON posts.author_id = users.id
  GROUP BY users.id, users.name
  HAVING COUNT(posts.id) > 10
`);
```

### Transaction-like Operations

```typescript
try {
  const user = await db.crud.users.create({
    id: "1",
    name: "Alice"
  });
  
  const post = await db.crud.posts.create({
    id: "1",
    authorId: user.id,
    title: "My First Post"
  });
  
  // All succeeded
} catch (error) {
  // Rollback logic or error handling
  console.error("Operation failed:", error);
}
```

---

## Using with Other Libraries

The CRUD module can be used standalone with any database library. Just import from `jsr:@oxian/ominipg/crud`.

### With postgres.js (Deno)

```typescript
import postgres from "https://deno.land/x/postgres/mod.ts";
import { defineSchema, createCrudApi } from "jsr:@oxian/ominipg/crud";

// Setup postgres.js
const sql = postgres("postgresql://user:pass@localhost:5432/db");

// Define schemas
const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        email: { type: "string" }
      },
      required: ["name", "email"]
    },
    keys: [{ property: "id" }]
  }
});

// Create query function
async function queryFn(sqlStr: string, params?: unknown[]) {
  const result = await sql.unsafe(sqlStr, params ?? []);
  return { rows: result as unknown[] };
}

// Create CRUD API
const crud = createCrudApi(schemas, queryFn);

// Use it!
const user = await crud.users.create({
  name: "Alice",
  email: "alice@example.com"
});

const users = await crud.users.find({ name: { $like: "A%" } });

// Cleanup
await sql.end();
```

### With node-postgres (pg)

```typescript
import { Pool } from "npm:pg";
import { defineSchema, createCrudApi } from "jsr:@oxian/ominipg/crud";

// Setup pg pool
const pool = new Pool({
  connectionString: "postgresql://user:pass@localhost:5432/db"
});

// Define schemas
const schemas = defineSchema({
  products: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        price: { type: "number" }
      },
      required: ["id", "name", "price"]
    },
    keys: [{ property: "id" }]
  }
});

// Create query function
async function queryFn(sql: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params ?? []);
    return { rows: result.rows as unknown[] };
  } finally {
    client.release();
  }
}

// Create CRUD API
const crud = createCrudApi(schemas, queryFn);

// Use it!
const product = await crud.products.create({
  id: "prod_1",
  name: "Laptop",
  price: 1299.99
});

const expensiveProducts = await crud.products.find({
  price: { $gte: 1000 }
});

// Cleanup
await pool.end();
```

### With Drizzle ORM

You can combine the CRUD API with Drizzle:

```typescript
import { drizzle } from "npm:drizzle-orm/node-postgres";
import { Pool } from "npm:pg";
import { defineSchema, createCrudApi } from "jsr:@oxian/ominipg/crud";

// Setup Drizzle with pg
const pool = new Pool({ connectionString: "postgresql://..." });
const db = drizzle(pool);

// Define CRUD schemas
const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        email: { type: "string" }
      },
      required: ["name", "email"]
    },
    keys: [{ property: "id" }]
  }
});

// Create query function using Drizzle's underlying connection
async function queryFn(sql: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params ?? []);
    return { rows: result.rows as unknown[] };
  } finally {
    client.release();
  }
}

// Create CRUD API
const crud = createCrudApi(schemas, queryFn);

// Now you can use both!
// Drizzle for complex queries
const complexResult = await db.select().from(usersTable)
  .leftJoin(postsTable, eq(postsTable.userId, usersTable.id));

// CRUD API for simple operations
const user = await crud.users.create({
  name: "Alice",
  email: "alice@example.com"
});

const activeUsers = await crud.users.find({
  status: "active"
});
```

### With Custom Database Layer

```typescript
import { defineSchema, createCrudApi } from "jsr:@oxian/ominipg/crud";

// Your custom database abstraction
class MyDatabase {
  async query(sql: string, params?: unknown[]) {
    // Your implementation
    return { rows: [] };
  }
}

const myDb = new MyDatabase();

// Define schemas
const schemas = defineSchema({
  orders: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        customerId: { type: "string" },
        total: { type: "number" },
        status: { type: "string" }
      },
      required: ["id", "customerId", "total"]
    },
    keys: [{ property: "id" }],
    timestamps: true
  }
});

// Create CRUD API
const crud = createCrudApi(schemas, (sql, params) => myDb.query(sql, params));

// Use it!
const order = await crud.orders.create({
  id: "order_1",
  customerId: "cust_1",
  total: 99.99,
  status: "pending"
});

const pendingOrders = await crud.orders.find({
  status: "pending"
});
```

### Benefits of Standalone Usage

- ✅ **Flexibility** - Use with any database library
- ✅ **No vendor lock-in** - Not tied to Ominipg's connection layer
- ✅ **Lightweight** - Only import what you need
- ✅ **Composable** - Combine with other tools (Drizzle, Kysely, etc.)
- ✅ **Type-safe** - Full TypeScript support maintained

### Query Function Interface

Your query function must match this signature:

```typescript
type QueryFunction = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: unknown[] }>;
```

**Requirements:**
- Accepts SQL string with `$1`, `$2`, etc. placeholders
- Accepts optional array of parameters
- Returns promise with `{ rows: unknown[] }` shape

---

## Performance Tips

### 1. Use `createMany` for Bulk Inserts

```typescript
// ✅ Fast - single query
await db.crud.users.createMany(users);

// ❌ Slow - multiple queries
for (const user of users) {
  await db.crud.users.create(user);
}
```

### 2. Select Only Needed Fields

```typescript
// ✅ Fast - only fetches needed columns
const users = await db.crud.users.find(
  {},
  { select: ["id", "name"] }
);

// ❌ Slower - fetches all columns
const users = await db.crud.users.find();
```

### 3. Use Indexes

Create indexes on frequently queried columns:

```typescript
schemaSQL: [
  `CREATE INDEX idx_users_email ON users(email)`,
  `CREATE INDEX idx_posts_author_id ON posts(author_id)`
]
```

### 4. Limit Results

```typescript
// Pagination
const page1 = await db.crud.users.find(
  {},
  { limit: 10, skip: 0 }
);

const page2 = await db.crud.users.find(
  {},
  { limit: 10, skip: 10 }
);
```

---

## Complete Example

```typescript
import { Ominipg, defineSchema } from "jsr:@oxian/ominipg";

// Define schemas
const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        posts: {
          readOnly: true,
          type: "array",
          items: { $ref: "#/$defs/posts" }
        }
      },
      required: ["id", "name", "email"]
    },
    keys: [{ property: "id" }]
  },
  posts: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        authorId: { $ref: "#/$defs/users/properties/id" },
        title: { type: "string" },
        body: { type: "string" },
        published: { type: "boolean" },
        created_at: { type: "string" },
        updated_at: { type: "string" },
        author: {
          readOnly: true,
          anyOf: [{ $ref: "#/$defs/users" }, { type: "null" }]
        }
      },
      required: ["id", "authorId", "title", "body"]
    },
    keys: [{ property: "id" }],
    timestamps: true
  }
});

// Infer types
type User = typeof schemas.users.$inferSelect;
type NewUser = typeof schemas.users.$inferInsert;
type Post = typeof schemas.posts.$inferSelect;
type NewPost = typeof schemas.posts.$inferInsert;

// Connect
const db = await Ominipg.connect({
  url: ":memory:",
  schemas,
  schemaSQL: [/* DDL statements */]
});

// Create user
const alice = await db.crud.users.create({
  id: "1",
  name: "Alice",
  email: "alice@example.com"
});

// Create posts
await db.crud.posts.createMany([
  {
    id: "1",
    authorId: alice.id,
    title: "Hello World",
    body: "My first post!",
    published: true
  },
  {
    id: "2",
    authorId: alice.id,
    title: "Ominipg is Great",
    body: "I love this library!",
    published: true
  }
]);

// Find with populate
const user = await db.crud.users.findOne(
  { id: "1" },
  { populate: ["posts"] }
);

console.log(user.posts); // Array of posts

// Find published posts with author
const posts = await db.crud.posts.find(
  { published: true },
  { populate: ["author"] }
);

posts.forEach(post => {
  console.log(`${post.title} by ${post.author.name}`);
});

// Update post
await db.crud.posts.update(
  { id: "1" },
  { title: "Hello World (Updated)" }
);

// Delete post
await db.crud.posts.delete({ id: "2" });

await db.close();
```

---

## See Also

- [API Reference](./API.md)
- [Schema Definition Guide](./SCHEMA.md)
- [Drizzle Integration](./DRIZZLE.md)
- [Examples](../examples)

