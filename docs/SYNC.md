# Sync Guide

Build local-first applications with automatic synchronization between local PGlite and remote PostgreSQL databases.

---

## Table of Contents

- [What is Local-First?](#what-is-local-first)
- [How Sync Works](#how-sync-works)
- [Setup](#setup)
- [Syncing Data](#syncing-data)
- [Sync Strategies](#sync-strategies)
- [Conflict Resolution](#conflict-resolution)
- [Best Practices](#best-practices)
- [Limitations](#limitations)

---

## What is Local-First?

**Local-first** applications store data locally on the user's device and sync with a remote server when available. This provides:

- ✅ **Offline capability** - App works without internet connection
- ✅ **Instant responsiveness** - No waiting for network requests
- ✅ **Data ownership** - User's data lives on their device
- ✅ **Resilience** - App continues working during network issues

**Ominipg makes local-first easy** by providing automatic sync between:
- **Local database** (PGlite in-memory or persistent)
- **Remote database** (PostgreSQL server)

---

## How Sync Works

### Architecture

```
┌──────────────────────────────────────────┐
│          Your Application                │
└────────────┬─────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────┐
│        Ominipg Client                    │
│  - query() → local database              │
│  - sync() → push to remote               │
└────────────┬─────────────────────────────┘
             │
    ┌────────┴────────┐
    │                 │
    ▼                 ▼
┌─────────┐      ┌─────────┐
│ PGlite  │      │  Sync   │
│ (Local) │      │ Manager │
└─────────┘      └────┬────┘
                      │
                      ▼ (Push changes)
              ┌──────────────┐
              │ PostgreSQL   │
              │  (Remote)    │
              └──────────────┘
```

### Sync Process

1. **Local Operations**: All queries run against local PGlite database
2. **Change Tracking**: Ominipg tracks INSERT/UPDATE/DELETE operations
3. **Push Changes**: `sync()` pushes tracked changes to remote PostgreSQL
4. **Sequence Sync**: Sequence values (auto-increment IDs) are synchronized

### What Gets Synced

- ✅ **INSERT** operations
- ✅ **UPDATE** operations
- ✅ **DELETE** operations
- ✅ **Sequence values** (for auto-increment IDs)

### What Doesn't Get Synced

- ❌ **DDL changes** (CREATE TABLE, ALTER TABLE, etc.)
- ❌ **Initial data pull** (from remote to local)
- ❌ **Bi-directional sync** (only local → remote)

---

## Setup

### Enable Sync

To enable sync, provide both `url` (local) and `syncUrl` (remote):

```typescript
import { Ominipg } from "jsr:@oxian/ominipg";

const db = await Ominipg.connect({
  // Local database (in-memory)
  url: ":memory:",
  
  // Remote database (PostgreSQL)
  syncUrl: "postgresql://user:password@host:5432/database",
  
  // Schema must exist on both databases
  schemaSQL: [
    `CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`
  ]
});
```

### Persistent Local Database

For persistent local storage (survives app restarts):

```typescript
const db = await Ominipg.connect({
  // Use a file path instead of :memory:
  url: "./local.db",
  syncUrl: "postgresql://...",
  schemaSQL: [/* ... */]
});
```

### Schema Synchronization

**Important**: Schema must be identical on both local and remote databases.

```typescript
// Option 1: Let Ominipg create schema on both
const db = await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://...",
  schemaSQL: [
    // These DDL statements run on both local and remote
    `CREATE TABLE IF NOT EXISTS users (...)`,
    `CREATE TABLE IF NOT EXISTS posts (...)`
  ]
});

// Option 2: Ensure schema exists on remote first
// Then let Ominipg create local schema
const db = await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://...", // Schema already exists here
  schemaSQL: [
    // Only creates schema locally
    `CREATE TABLE IF NOT EXISTS users (...)`
  ]
});
```

---

## Syncing Data

### Manual Sync

Call `sync()` to push local changes to remote:

```typescript
// Make local changes
await db.query("INSERT INTO users (name, email) VALUES ($1, $2)", [
  "Alice",
  "alice@example.com"
]);

await db.query("INSERT INTO users (name, email) VALUES ($1, $2)", [
  "Bob",
  "bob@example.com"
]);

// Push to remote
const result = await db.sync();
console.log(`Pushed ${result.pushed} changes to remote`);
```

### Sync Events

Listen to sync events for progress tracking:

```typescript
db.on("sync:start", () => {
  console.log("Sync started...");
  // Show loading indicator
});

db.on("sync:end", (result) => {
  console.log(`Sync completed: ${result.pushed} changes pushed`);
  // Hide loading indicator
});

db.on("error", (error) => {
  console.error("Sync error:", error);
  // Show error message to user
});

// Trigger sync
await db.sync();
```

### Periodic Sync

Set up automatic periodic sync:

```typescript
// Sync every 5 minutes
const syncInterval = setInterval(async () => {
  try {
    const result = await db.sync();
    console.log(`Auto-sync: ${result.pushed} changes`);
  } catch (error) {
    console.error("Auto-sync failed:", error);
  }
}, 5 * 60 * 1000);

// Clean up on app close
await db.close();
clearInterval(syncInterval);
```

### Sync on Connection Change

Sync when network becomes available:

```typescript
// Listen for online event (browser)
if (typeof window !== "undefined") {
  window.addEventListener("online", async () => {
    console.log("Network available, syncing...");
    try {
      await db.sync();
    } catch (error) {
      console.error("Sync failed:", error);
    }
  });
}
```

---

## Sync Strategies

### Strategy 1: Sync on Demand

User manually triggers sync:

```typescript
// Button click handler
async function handleSyncClick() {
  try {
    setLoading(true);
    const result = await db.sync();
    alert(`Synced ${result.pushed} changes`);
  } catch (error) {
    alert("Sync failed: " + error.message);
  } finally {
    setLoading(false);
  }
}
```

**Pros:**
- User has full control
- No surprise network usage

**Cons:**
- User might forget to sync
- Risk of data loss

### Strategy 2: Automatic Background Sync

Sync automatically in the background:

```typescript
class SyncManager {
  private db: Ominipg;
  private intervalId?: number;
  
  constructor(db: Ominipg) {
    this.db = db;
  }
  
  start(intervalMs: number = 5 * 60 * 1000) {
    this.intervalId = setInterval(async () => {
      try {
        await this.db.sync();
      } catch (error) {
        console.error("Background sync failed:", error);
      }
    }, intervalMs);
  }
  
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }
  
  async syncNow() {
    return await this.db.sync();
  }
}

// Usage
const syncManager = new SyncManager(db);
syncManager.start(); // Auto-sync every 5 minutes

// Manual sync when needed
await syncManager.syncNow();

// Stop on cleanup
syncManager.stop();
```

**Pros:**
- Always in sync
- No user intervention needed

**Cons:**
- Network usage
- Battery drain

### Strategy 3: Smart Sync

Sync based on conditions:

```typescript
class SmartSyncManager {
  private db: Ominipg;
  private pendingChanges = 0;
  private lastSync = Date.now();
  
  constructor(db: Ominipg) {
    this.db = db;
    this.startMonitoring();
  }
  
  private startMonitoring() {
    // Monitor local changes
    setInterval(() => {
      this.considerSync();
    }, 30 * 1000); // Check every 30 seconds
  }
  
  onLocalChange() {
    this.pendingChanges++;
    this.considerSync();
  }
  
  private async considerSync() {
    const timeSinceLastSync = Date.now() - this.lastSync;
    const shouldSync = 
      this.pendingChanges >= 10 || // At least 10 changes
      (this.pendingChanges > 0 && timeSinceLastSync > 5 * 60 * 1000); // Or 5 min passed
    
    if (shouldSync && navigator.onLine) {
      try {
        const result = await this.db.sync();
        this.pendingChanges = 0;
        this.lastSync = Date.now();
        console.log(`Smart sync: ${result.pushed} changes`);
      } catch (error) {
        console.error("Smart sync failed:", error);
      }
    }
  }
}

// Usage
const smartSync = new SmartSyncManager(db);

// Notify after changes
await db.query("INSERT INTO users ...");
smartSync.onLocalChange();
```

**Pros:**
- Balances freshness and efficiency
- Adapts to usage patterns

**Cons:**
- More complex implementation

### Strategy 4: Critical-First Sync

Prioritize critical data:

```typescript
async function syncCriticalData() {
  // Sync high-priority tables first
  await db.query(`
    -- Mark critical changes for sync
    UPDATE _sync_queue 
    SET priority = 1 
    WHERE table_name IN ('orders', 'payments')
  `);
  
  await db.sync();
}

async function syncAll() {
  await db.sync();
}

// Sync critical data immediately
await db.query("INSERT INTO orders ...");
await syncCriticalData();

// Sync everything else later
setTimeout(syncAll, 60000);
```

---

## Conflict Resolution

### Current Behavior

**Ominipg currently uses "last write wins" strategy:**
- Remote changes overwrite local changes
- No automatic conflict detection

### Handling Conflicts

#### 1. Timestamps

Use timestamps to detect conflicts:

```typescript
const schemaSQL = [
  `CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name TEXT,
    version INTEGER DEFAULT 1,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`
];

// On update, increment version
await db.query(`
  UPDATE users 
  SET name = $1, version = version + 1, updated_at = NOW()
  WHERE id = $2
`, [newName, userId]);

// Before sync, check remote version
const remote = await remoteDb.query(
  "SELECT version FROM users WHERE id = $1",
  [userId]
);

if (remote.rows[0].version > localVersion) {
  console.warn("Conflict detected! Remote has newer version");
  // Handle conflict...
}
```

#### 2. Optimistic Locking

```typescript
async function updateWithOptimisticLock(
  id: string,
  currentVersion: number,
  newData: object
) {
  const result = await db.query(`
    UPDATE users 
    SET name = $1, version = version + 1
    WHERE id = $2 AND version = $3
    RETURNING *
  `, [newData.name, id, currentVersion]);
  
  if (result.rows.length === 0) {
    throw new Error("Update conflict: Record was modified");
  }
  
  return result.rows[0];
}

// Usage
try {
  await updateWithOptimisticLock("1", currentVersion, { name: "New Name" });
  await db.sync();
} catch (error) {
  console.error("Conflict:", error);
  // Fetch latest version and retry
}
```

#### 3. Merge Strategy

For append-only data (like logs, events):

```typescript
// Local and remote both append
// No conflicts since we're not updating

await db.query("INSERT INTO events (type, data) VALUES ($1, $2)", [
  "user_action",
  JSON.stringify(data)
]);

// Sync safely - inserts don't conflict
await db.sync();
```

---

## Best Practices

### 1. Sync Frequency

```typescript
// ✅ Good: Reasonable intervals
const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes

// ❌ Bad: Too frequent
const SYNC_INTERVAL = 1000; // Every second
```

### 2. Error Handling

```typescript
async function syncWithRetry(maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await db.sync();
    } catch (error) {
      console.error(`Sync attempt ${i + 1} failed:`, error);
      if (i === maxRetries - 1) throw error;
      // Exponential backoff
      await new Promise(resolve => 
        setTimeout(resolve, Math.pow(2, i) * 1000)
      );
    }
  }
}
```

### 3. User Feedback

```typescript
let syncStatus = "idle"; // idle | syncing | success | error

db.on("sync:start", () => {
  syncStatus = "syncing";
  updateUI();
});

db.on("sync:end", (result) => {
  syncStatus = "success";
  showToast(`Synced ${result.pushed} changes`);
  updateUI();
});

db.on("error", (error) => {
  syncStatus = "error";
  showToast("Sync failed: " + error.message, "error");
  updateUI();
});
```

### 4. Schema Versioning

```typescript
// Track schema version
const SCHEMA_VERSION = 2;

const schemaSQL = [
  `CREATE TABLE IF NOT EXISTS _schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  
  // Version 1 tables
  `CREATE TABLE IF NOT EXISTS users (...)`,
  
  // Version 2 migration
  `DO $$ 
  BEGIN
    IF NOT EXISTS (SELECT FROM _schema_version WHERE version = 2) THEN
      ALTER TABLE users ADD COLUMN last_login TIMESTAMPTZ;
      INSERT INTO _schema_version (version) VALUES (2);
    END IF;
  END $$`
];
```

### 5. Batch Changes

```typescript
// ✅ Good: Batch operations before sync
await db.query("BEGIN");
try {
  for (const user of users) {
    await db.query("INSERT INTO users ...", [user]);
  }
  await db.query("COMMIT");
  await db.sync(); // Single sync for all changes
} catch (error) {
  await db.query("ROLLBACK");
}

// ❌ Bad: Sync after each operation
for (const user of users) {
  await db.query("INSERT INTO users ...", [user]);
  await db.sync(); // Too many syncs!
}
```

---

## Limitations

### Current Limitations

1. **Unidirectional Sync**
   - Only local → remote
   - No remote → local sync (pull)
   - No bi-directional sync

2. **No Initial Data Pull**
   - Can't automatically fetch existing remote data
   - Must manually initialize local database

3. **No Conflict Detection**
   - Uses "last write wins"
   - No automatic conflict resolution

4. **Schema Must Match**
   - Local and remote schemas must be identical
   - No automatic schema migration

5. **No Selective Sync**
   - All tracked changes are synced
   - Can't sync specific tables only

### Workarounds

**Pull data initially:**

```typescript
// After connecting, pull existing data
const remoteData = await fetch("https://api.example.com/users");
const users = await remoteData.json();

for (const user of users) {
  await db.query(
    "INSERT INTO users (id, name, email) VALUES ($1, $2, $3)",
    [user.id, user.name, user.email]
  );
}

// Now local has remote data, ready for sync
```

**Selective sync with flags:**

```typescript
// Add sync_enabled column
const schemaSQL = [
  `CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name TEXT,
    sync_enabled BOOLEAN DEFAULT TRUE
  )`
];

// Only sync enabled records (manual implementation)
const changedRecords = await db.query(`
  SELECT * FROM users WHERE sync_enabled = TRUE
`);

// Push to remote manually
for (const record of changedRecords.rows) {
  await remoteDb.query("INSERT INTO users ... ON CONFLICT ...");
}
```

---

## Complete Example

```typescript
import { Ominipg } from "jsr:@oxian/ominipg";

// 1. Setup with sync
const db = await Ominipg.connect({
  url: ":memory:",
  syncUrl: "postgresql://user:pass@host:5432/db",
  schemaSQL: [
    `CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      completed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`
  ]
});

// 2. Setup sync events
db.on("sync:start", () => console.log("🔄 Syncing..."));
db.on("sync:end", (r) => console.log(`✅ Synced ${r.pushed} changes`));
db.on("error", (e) => console.error("❌ Error:", e));

// 3. Work offline - all local
await db.query(
  "INSERT INTO todos (title) VALUES ($1)",
  ["Buy groceries"]
);

await db.query(
  "INSERT INTO todos (title) VALUES ($1)",
  ["Write documentation"]
);

await db.query(
  "UPDATE todos SET completed = TRUE WHERE id = $1",
  [1]
);

// 4. Sync when ready
const result = await db.sync();
console.log(`Synced ${result.pushed} changes`);

// 5. Setup auto-sync
const syncInterval = setInterval(async () => {
  try {
    await db.sync();
  } catch (error) {
    console.error("Auto-sync failed:", error);
  }
}, 5 * 60 * 1000);

// 6. Cleanup
await db.close();
clearInterval(syncInterval);
```

---

## See Also

- [API Reference](./API.md)
- [Architecture](./ARCHITECTURE.md)
- [Examples](../examples)


