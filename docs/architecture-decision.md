# Architecture Decision: ORM-Agnostic Design

## Problem

Originally, Ominipg was tightly coupled to Drizzle ORM by:
- Importing drizzle directly in the library
- Forcing users to have drizzle as a dependency 
- Returning a drizzle instance from `Ominipg.connect()`

This limited flexibility and forced dependencies on users who might prefer other query interfaces.

## Solution

We refactored Ominipg to be **ORM-agnostic** by:

1. **Removing direct drizzle imports** from the core library
2. **Returning the raw Ominipg instance** instead of a drizzle instance
3. **Providing examples** of how to integrate with Drizzle using the proxy pattern
4. **Adding a built-in `withDrizzle` helper** for seamless Drizzle integration
5. **Keeping the same functionality** while giving users choice

## Benefits

### ✅ For Raw SQL Users
```typescript
import { Ominipg } from 'jsr:@oxian/ominipg';

const db = await Ominipg.connect({
  url: 'postgres://localhost:5432/mydb',
  schemaSQL: ['CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)']
});

// Direct SQL queries, no ORM dependencies
const users = await db.query('SELECT * FROM users');
await db.query('INSERT INTO users (name) VALUES ($1)', ['Alice']);
```

### ✅ For Drizzle Users (Built-in Helper)
```typescript
import { Ominipg, withDrizzle } from 'jsr:@oxian/ominipg';

// Connect to Ominipg first
const ominipg = await Ominipg.connect({...});

// Option 1: Auto-import (async)
const db = await withDrizzle(ominipg, schema);

// Option 2: Explicit import (sync)
import { drizzle } from 'drizzle-orm/pg-proxy';
const db = withDrizzle(ominipg, drizzle, schema);

// Use Drizzle syntax + Ominipg methods
const users = await db.select().from(userTable);
await db.sync();
```

### ✅ For Drizzle Users (Manual Proxy)
```typescript
import { drizzle } from 'drizzle-orm/pg-proxy';
import { Ominipg } from 'jsr:@oxian/ominipg';

// Connect to Ominipg first
const ominipg = await Ominipg.connect({...});

// Create Drizzle adapter using proxy pattern
const db = drizzle(async (sql, params, method) => {
  const result = await ominipg.query(sql, params);
  
  // Handle different return formats based on method
  if (method === 'all') {
    // Convert objects to arrays for SELECT queries
    return { rows: result.rows.map(row => Object.values(row)) };
  } else {
    // Return objects as-is for other operations
    return { rows: result.rows };
  }
}, { schema });

// Use Drizzle syntax
const users = await db.select().from(userTable);
```

### ✅ For Other ORM Users
Users can easily create adapters for:
- Kysely
- TypeORM  
- Prisma
- Any other query builder/ORM

## Technical Implementation

### Core Library Changes
- Removed `import { drizzle }` from `src/client/index.ts`
- Changed return type from `Promise<any>` to `Promise<Ominipg>`
- Renamed `queryRaw()` to `query()` (keeping `queryRaw()` for backward compatibility)
- Removed `schema` property from connection options
- **Added `withDrizzle()` helper function** with two modes:
  - Async mode with auto-import: `await withDrizzle(ominipg, schema)`
  - Sync mode with explicit import: `withDrizzle(ominipg, drizzle, schema)`

### Drizzle Proxy Implementation
The `withDrizzle` helper properly handles Drizzle's proxy protocol:
- **Method parameter**: Handles `'get'`, `'all'`, `'execute'`, `'run'`, `'values'`
- **Return format**: 
  - `method === 'get'`: Returns `{ rows: string[] }`
  - `method === 'all'`: Returns `{ rows: string[][] }` (converts objects to arrays)
  - Other methods: Returns `{ rows: object[] }`
- **Input/Output mapping**: Correctly maps between Ominipg's object format and Drizzle's expected formats

## Migration Guide

### Before (Tightly Coupled)
```typescript
const db = await Ominipg.connect({
  url: 'postgres://...',
  schema: drizzleSchema,
  schemaSQL: schemaDDL
});

// db was a drizzle instance
const users = await db.select().from(userTable);
```

### After (Flexible)
```typescript
// Option 1: Raw SQL (no ORM dependencies)
const db = await Ominipg.connect({
  url: 'postgres://...',
  schemaSQL: schemaDDL
});
const users = await db.query('SELECT * FROM users');

// Option 2: Drizzle with built-in helper (recommended)
const ominipg = await Ominipg.connect({
  url: 'postgres://...',
  schemaSQL: schemaDDL
});
const db = await withDrizzle(ominipg, drizzleSchema);
const users = await db.select().from(userTable);

// Option 3: Manual Drizzle proxy (advanced)
const ominipg = await Ominipg.connect({...});
const db = createDrizzleAdapter(ominipg, drizzleSchema);
const users = await db.select().from(userTable);
```

## Conclusion

This architectural change makes Ominipg more flexible and allows users to choose their preferred data access pattern while maintaining all the unique features (sync, edge capabilities, worker-based execution) that make Ominipg valuable. 