# Architecture Guide

Understanding how Ominipg works under the hood.

---

## Table of Contents

- [Overview](#overview)
- [Architecture Diagram](#architecture-diagram)
- [Components](#components)
- [Worker Mode vs Direct Mode](#worker-mode-vs-direct-mode)
- [Request Flow](#request-flow)
- [Sync Mechanism](#sync-mechanism)
- [Performance Characteristics](#performance-characteristics)
- [Design Decisions](#design-decisions)

---

## Overview

Ominipg is designed around a **flexible, multi-mode architecture** that adapts to different use cases:

- **Worker Mode**: Database operations in isolated Web Worker
- **Direct Mode**: Direct connection to PostgreSQL
- **Sync Mode**: Local PGlite synced with remote PostgreSQL

This architecture provides:
- ⚡ **Performance**: Choose between isolation (worker) and speed (direct)
- 🔒 **Isolation**: Worker mode keeps database operations off main thread
- 🔄 **Local-first**: Built-in sync for offline-capable apps
- 🎯 **Flexibility**: Multiple API styles (SQL, ORM, CRUD)

---

## Architecture Diagram

### High-Level Overview

```
┌─────────────────────────────────────────────────────┐
│              Application Layer                      │
│  - Your code                                        │
│  - UI components                                    │
│  - Business logic                                   │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│              Ominipg Client                         │
│  - Public API (query, crud, sync)                   │
│  - Request manager                                  │
│  - Event emitter                                    │
│  - CRUD API generator                               │
└────────┬──────────────────────┬─────────────────────┘
         │                      │
         │ (useWorker)          │ (direct mode)
         ▼                      ▼
┌─────────────────┐    ┌─────────────────┐
│  Worker Mode    │    │  Direct Mode    │
│                 │    │                 │
│  ┌───────────┐  │    │  ┌───────────┐  │
│  │  Worker   │  │    │  │ pg.Pool   │  │
│  │  Thread   │  │    │  │           │  │
│  │           │  │    │  └─────┬─────┘  │
│  │ ┌───────┐ │  │    │        │        │
│  │ │PGlite │ │  │    │        ▼        │
│  │ │  or   │ │  │    │  ┌───────────┐  │
│  │ │  pg   │ │  │    │  │PostgreSQL │  │
│  │ └───┬───┘ │  │    │  │  Server   │  │
│  │     │     │  │    │  └───────────┘  │
│  └─────┼─────┘  │    └─────────────────┘
│        │        │
│   ┌────▼─────┐  │
│   │Sync Mgr  │  │ (optional)
│   └────┬─────┘  │
└────────┼────────┘
         │
         ▼
  ┌─────────────┐
  │ PostgreSQL  │
  │  (Remote)   │
  └─────────────┘
```

### Detailed Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Ominipg Client (Main Thread)                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   Public     │  │    CRUD      │  │   Drizzle    │          │
│  │     API      │  │   Generator  │  │   Adapter    │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                  │
│         └─────────────────┼─────────────────┘                  │
│                           │                                    │
│                  ┌────────▼────────┐                           │
│                  │ Request Manager │                           │
│                  │  - ID generation │                           │
│                  │  - Timeouts      │                           │
│                  │  - Response map  │                           │
│                  └────────┬────────┘                           │
│                           │                                    │
│                  ┌────────▼────────┐                           │
│                  │  postMessage()  │                           │
│                  └────────┬────────┘                           │
└───────────────────────────┼──────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
    ┌─────────▼────────┐      ┌──────────▼───────┐
    │  Worker Thread   │      │   Direct Pool    │
    │                  │      │   (pg.Pool)      │
    │  ┌────────────┐  │      └──────────────────┘
    │  │ onMessage  │  │
    │  └──────┬─────┘  │
    │         │        │
    │  ┌──────▼─────┐  │
    │  │DB Handler  │  │
    │  │- exec      │  │
    │  │- sync      │  │
    │  │- diagnostic│  │
    │  └──────┬─────┘  │
    │         │        │
    │  ┌──────▼─────┐  │
    │  │  Database  │  │
    │  │  (PGlite/  │  │
    │  │   pg)      │  │
    │  └──────┬─────┘  │
    │         │        │
    │  ┌──────▼─────┐  │
    │  │Sync Manager│  │ (if syncUrl provided)
    │  │- Tracker   │  │
    │  │- Pusher    │  │
    │  │- Puller    │  │
    │  └────────────┘  │
    └──────────────────┘
```

---

## Components

### 1. Ominipg Client (Main Thread)

The client is the main interface your application interacts with.

**Responsibilities:**
- Provide public API (`query`, `sync`, `crud`, etc.)
- Manage worker lifecycle
- Handle request/response correlation
- Emit events
- Manage CRUD API generation

**Key Files:**
- `src/client/index.ts` - Main client class
- `src/client/types.ts` - Type definitions
- `src/client/crud/` - CRUD API implementation

**Code Structure:**
```typescript
class Ominipg extends TypedEmitter {
  private mode: "worker" | "direct";
  private worker?: Worker;
  private requests?: RequestManager;
  private pool?: PgPool;
  public crud?: CrudApi;
  
  static async connect(options) { /* ... */ }
  async query(sql, params) { /* ... */ }
  async sync() { /* ... */ }
  async close() { /* ... */ }
}
```

### 2. Request Manager

Handles communication between main thread and worker.

**Responsibilities:**
- Generate unique request IDs
- Track pending requests
- Handle timeouts
- Route responses to correct promise

**Message Format:**
```typescript
// Request
{
  type: "exec" | "sync" | "diagnostic" | "close",
  reqId: number,
  sql?: string,
  params?: unknown[]
}

// Response
{
  type: "exec-result" | "error",
  reqId: number,
  rows?: unknown[],
  error?: string
}
```

### 3. Worker Thread

Isolated execution context for database operations.

**Responsibilities:**
- Initialize database (PGlite or PostgreSQL)
- Execute SQL queries
- Manage sync operations
- Track schema changes
- Handle cleanup

**Key Files:**
- `src/worker/index.ts` - Worker entry point
- `src/worker/db.ts` - Database abstraction
- `src/worker/sync/` - Sync mechanism

**Message Handler:**
```typescript
self.onmessage = async (event: MessageEvent<WorkerMsg>) => {
  const msg = event.data;
  
  switch (msg.type) {
    case "init":
      await initializeDatabase(msg);
      break;
    case "exec":
      const result = await executeQuery(msg.sql, msg.params);
      postMessage({ type: "exec-result", reqId: msg.reqId, ...result });
      break;
    case "sync":
      const syncResult = await syncChanges();
      postMessage({ type: "sync-result", reqId: msg.reqId, ...syncResult });
      break;
  }
};
```

### 4. Database Layer

Abstraction over PGlite and PostgreSQL.

**Interface:**
```typescript
interface Database {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  close(): Promise<void>;
}

// PGlite implementation
class PGliteDatabase implements Database {
  private db: PGlite;
  async query(sql, params) { /* ... */ }
}

// PostgreSQL implementation
class PostgresDatabase implements Database {
  private pool: Pool;
  async query(sql, params) { /* ... */ }
}
```

### 5. Sync Manager

Handles synchronization between local and remote databases.

**Components:**

**Tracker:**
- Monitors INSERT/UPDATE/DELETE operations
- Stores changes in `_changes` table
- Assigns sequence numbers to changes

**Pusher:**
- Reads from `_changes` table
- Applies changes to remote database
- Handles conflict resolution (last write wins)
- Clears synced changes

**Sequences:**
- Synchronizes auto-increment values
- Prevents ID conflicts

**Key Files:**
- `src/worker/sync/manager.ts` - Main sync orchestration
- `src/worker/sync/pusher.ts` - Push logic
- `src/worker/sync/sequences.ts` - Sequence sync
- `src/worker/sync/initial.ts` - Initial setup

### 6. CRUD Generator

Generates type-safe CRUD API from JSON Schema.

**Process:**
1. Parse JSON Schema definitions
2. Generate Zod schemas for validation
3. Create table-specific API methods
4. Infer TypeScript types
5. Build filter → SQL compiler

**Key Files:**
- `src/client/crud/index.ts` - API generator
- `src/client/crud/schema.ts` - Schema processing
- `src/client/crud/filter.ts` - Filter compiler
- `src/client/crud/types.ts` - Type definitions

---

## Worker Mode vs Direct Mode

### Worker Mode (Default)

**When Used:**
- PGlite databases (in-memory or file-based)
- PostgreSQL with sync enabled
- When `useWorker: true` is specified

**Advantages:**
- ✅ Non-blocking: Database operations don't block main thread
- ✅ Isolation: Separate memory space
- ✅ Sync support: Built-in sync mechanism

**Disadvantages:**
- ❌ Message overhead: Serialization/deserialization cost
- ❌ No shared state: Can't directly access database objects

**Flow:**
```
App → Client → postMessage → Worker → Database → Response → Client → App
      (main)                  (thread)
```

### Direct Mode

**When Used:**
- PostgreSQL connection without sync
- When `useWorker: false` is specified
- Optimization for simple PostgreSQL access

**Advantages:**
- ✅ Faster: No message passing overhead
- ✅ Simpler: Direct function calls
- ✅ Lower memory: No worker thread

**Disadvantages:**
- ❌ Blocks main thread: Long queries can freeze UI
- ❌ No sync support: Can't sync local/remote
- ❌ No isolation: Shares main thread memory

**Flow:**
```
App → Client → pg.Pool → PostgreSQL → Response → Client → App
      (main)
```

### Mode Selection

```typescript
// Automatic selection
const db = await Ominipg.connect({
  url: ":memory:", // → Worker mode (PGlite)
});

const db = await Ominipg.connect({
  url: "postgresql://...", // → Direct mode (no sync)
});

const db = await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://...", // → Worker mode (sync enabled)
});

// Force mode
const db = await Ominipg.connect({
  url: "postgresql://...",
  useWorker: true, // Force worker mode
});
```

---

## Request Flow

### Query Execution (Worker Mode)

```
1. Application calls db.query("SELECT ...")
   │
   ▼
2. Client.query() creates request
   - Generates reqId
   - Creates timeout
   - Stores promise in pending map
   │
   ▼
3. RequestManager.request() posts message
   - Message: { type: "exec", reqId, sql, params }
   │
   ▼
4. Worker receives message
   - onmessage handler
   │
   ▼
5. Worker.handleExec() executes query
   - Calls db.query(sql, params)
   - Gets result from PGlite/PostgreSQL
   │
   ▼
6. Worker posts response
   - Message: { type: "exec-result", reqId, rows }
   │
   ▼
7. Client receives response
   - RequestManager.handleMessage()
   - Matches reqId to pending request
   - Clears timeout
   - Resolves promise
   │
   ▼
8. Application receives result
   - Promise resolves with { rows }
```

### Query Execution (Direct Mode)

```
1. Application calls db.query("SELECT ...")
   │
   ▼
2. Client.query() directly calls pool
   - const client = await pool.connect()
   - const result = await client.query(sql, params)
   - client.release()
   │
   ▼
3. Application receives result
   - Promise resolves with { rows }
```

### CRUD Operation

```
1. Application calls db.crud.users.find({ age: { $gt: 18 } })
   │
   ▼
2. CRUD API processes filter
   - Parses filter object
   - Converts to SQL WHERE clause
   - Adds parameters
   │
   ▼
3. CRUD API calls db.query()
   - Generated SQL: "SELECT * FROM users WHERE age > $1"
   - Params: [18]
   │
   ▼
4. Follows normal query flow (worker or direct)
   │
   ▼
5. CRUD API validates response
   - Validates rows against schema
   - Populates relations if requested
   │
   ▼
6. Application receives typed result
   - Promise resolves with User[]
```

---

## Sync Mechanism

### Setup Phase

```
1. Connection with syncUrl
   │
   ▼
2. Worker creates sync manager
   - Connects to remote PostgreSQL
   - Creates _changes table
   - Creates triggers on tracked tables
   │
   ▼
3. Triggers capture changes
   - INSERT → INSERT into _changes
   - UPDATE → INSERT into _changes
   - DELETE → INSERT into _changes
```

### Sync Phase

```
1. Application calls db.sync()
   │
   ▼
2. Client posts sync message
   - { type: "sync", reqId }
   │
   ▼
3. Worker.handleSync() starts sync
   - Emits "sync:start" event
   │
   ▼
4. SyncManager.push() reads changes
   - SELECT * FROM _changes ORDER BY seq
   │
   ▼
5. For each change:
   - Apply to remote database
   - INSERT/UPDATE/DELETE on remote
   - Handle conflicts (last write wins)
   │
   ▼
6. Clear synced changes
   - DELETE FROM _changes WHERE seq <= ?
   │
   ▼
7. Sync sequences
   - SELECT currval() from remote
   - SELECT setval() on local
   │
   ▼
8. Return result
   - { pushed: number }
   │
   ▼
9. Client emits "sync:end"
   - Application receives result
```

### Change Tracking

**_changes Table:**
```sql
CREATE TABLE _changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL, -- INSERT, UPDATE, DELETE
  row_data JSONB,          -- Changed row data
  timestamp TIMESTAMPTZ DEFAULT NOW()
)
```

**Trigger Example:**
```sql
CREATE TRIGGER users_insert_trigger
AFTER INSERT ON users
FOR EACH ROW
BEGIN
  INSERT INTO _changes (table_name, operation, row_data)
  VALUES ('users', 'INSERT', json_object(NEW.*));
END;
```

---

## Performance Characteristics

### Latency Comparison

| Operation | Worker Mode | Direct Mode |
|-----------|-------------|-------------|
| Simple query | ~1-2ms overhead | Direct (fastest) |
| Complex query | Minimal overhead | Direct |
| CRUD operation | ~1-2ms overhead | Direct |
| Sync | N/A | N/A (not available) |

**Overhead Sources (Worker Mode):**
- Message serialization: ~0.1-0.5ms
- Context switching: ~0.5-1ms
- Result deserialization: ~0.1-0.5ms

### Memory Usage

| Mode | Client | Worker | Total |
|------|--------|--------|-------|
| Worker (PGlite) | ~5MB | ~30-50MB | ~35-55MB |
| Worker (PostgreSQL) | ~5MB | ~10-15MB | ~15-20MB |
| Direct (PostgreSQL) | ~5-10MB | - | ~5-10MB |

### Throughput

- **Worker Mode**: ~5,000-10,000 queries/sec
- **Direct Mode**: ~10,000-20,000 queries/sec
- **Sync**: ~1,000-2,000 records/sec

---

## Design Decisions

### Why Web Workers?

**Pros:**
- Non-blocking database operations
- Isolation prevents main thread contamination
- Better for long-running queries
- Required for sync mechanism (background processing)

**Cons:**
- Message passing overhead
- Can't share objects between threads
- More complex debugging

**Decision:** Default to worker mode for consistency, but allow direct mode for simple PostgreSQL use cases.

### Why JSON Schema?

**Alternatives Considered:**
- Zod (too JavaScript-specific)
- TypeScript types (runtime validation needed)
- Custom DSL (reinventing the wheel)

**Why JSON Schema:**
- Standard format
- Language-agnostic
- Rich ecosystem
- Can generate Zod for runtime validation
- Can generate TypeScript types

### Why Last-Write-Wins?

**Alternatives:**
- Operational transforms (complex)
- CRDTs (limited use cases)
- Manual conflict resolution (poor UX)

**Why LWW:**
- Simple to implement
- Works for 80% of use cases
- Easy to understand
- Can be extended later

### Why Unidirectional Sync?

**Current:** Local → Remote only

**Why:**
- Simpler implementation
- Covers local-first use case
- Avoids complex conflict resolution
- Can be extended to bidirectional later

---

## See Also

- [API Reference](./API.md)
- [Sync Guide](./SYNC.md)
- [Source Code](../src)

