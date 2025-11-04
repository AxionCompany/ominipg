# PGlite Extensions Guide

Enhance your local database with powerful PostgreSQL extensions.

---

## Table of Contents

- [Overview](#overview)
- [Available Extensions](#available-extensions)
- [Setup](#setup)
- [UUID Extension](#uuid-extension)
- [Vector Extension](#vector-extension)
- [PostGIS Extension](#postgis-extension)
- [Custom Extensions](#custom-extensions)
- [Troubleshooting](#troubleshooting)

---

## Overview

**Extensions** are PostgreSQL plugins that add extra functionality to your database. When using PGlite (in-memory or local databases), Ominipg supports loading extensions dynamically.

**Key Points:**
- ✅ Extensions work with **PGlite only** (`:memory:` or file-based)
- ❌ Extensions are **not loaded** for PostgreSQL connections
- 🔌 Extensions are loaded **at connection time**
- ⚡ Zero configuration - just specify extension names

### Why Use Extensions?

Extensions unlock advanced features:

- **UUID generation** - Unique identifiers without auto-increment
- **Vector search** - Semantic similarity and embeddings
- **Geographic data** - Maps and location queries
- **Full-text search** - Advanced text searching
- And more!

---

## Available Extensions

Popular extensions supported by PGlite:

| Extension | Description | Use Case |
|-----------|-------------|----------|
| `uuid_ossp` | UUID generation functions | Generate unique IDs |
| `vector` | Vector similarity search (pgvector) | AI embeddings, semantic search |
| `postgis` | Geographic information system | Maps, location queries |
| `pg_trgm` | Trigram text search | Fuzzy text matching |

**Note:** Extension availability depends on your PGlite version and build configuration.

---

## Setup

### Loading Extensions

Specify extensions in the `pgliteExtensions` option:

```typescript
import { Ominipg } from "jsr:@oxian/ominipg";

const db = await Ominipg.connect({
  url: ":memory:", // Must use PGlite
  
  // Load extensions
  pgliteExtensions: ["uuid_ossp", "vector"],

  // Tune WASM memory for heavier workloads
  pgliteConfig: {
    initialMemory: 256 * 1024 * 1024,
  },
  
  schemaSQL: [
    // Now you can use extension features
    `CREATE TABLE products (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name TEXT NOT NULL,
      embedding VECTOR(384)
    )`
  ]
});
```

### Graceful Degradation

Handle cases where extensions aren't available:

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteExtensions: ["uuid_ossp", "vector"],
  schemaSQL: [/* ... */]
});

// Test if extension is available
try {
  await db.query("SELECT uuid_generate_v4()");
  console.log("✅ UUID extension loaded");
} catch (error) {
  console.log("⚠️ UUID extension not available");
  // Fallback to alternative ID generation
}
```

---

## UUID Extension

Generate universally unique identifiers without sequences.

### Installation

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteExtensions: ["uuid_ossp"],
  schemaSQL: [
    `CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name TEXT NOT NULL,
      email TEXT UNIQUE
    )`
  ]
});
```

### Functions

#### `uuid_generate_v4()`

Generate a random UUID (version 4):

```typescript
// Generate UUID
const result = await db.query("SELECT uuid_generate_v4() as id");
console.log(result.rows[0].id);
// => "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"

// Use as default value
await db.query(`
  CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID NOT NULL,
    total DECIMAL(10,2)
  )
`);

// Insert without specifying ID
await db.query(`
  INSERT INTO orders (customer_id, total) 
  VALUES ($1, $2)
`, [customerId, 99.99]);
```

#### `uuid_generate_v1()`

Generate time-based UUID (version 1):

```typescript
const result = await db.query("SELECT uuid_generate_v1() as id");
```

#### `uuid_nil()`

Get the nil UUID (all zeros):

```typescript
const result = await db.query("SELECT uuid_nil() as id");
console.log(result.rows[0].id);
// => "00000000-0000-0000-0000-000000000000"
```

### Use Cases

**Distributed Systems:**
```typescript
// Each client generates unique IDs without coordination
const id = (await db.query("SELECT uuid_generate_v4()")).rows[0].uuid_generate_v4;

await db.query(
  "INSERT INTO events (id, type, data) VALUES ($1, $2, $3)",
  [id, "user_action", data]
);

// No ID conflicts when syncing!
await db.sync();
```

**Security:**
```typescript
// UUIDs are hard to guess (unlike sequential IDs)
const resetToken = (
  await db.query("SELECT uuid_generate_v4()")
).rows[0].uuid_generate_v4;

await db.query(
  "INSERT INTO password_resets (token, user_id) VALUES ($1, $2)",
  [resetToken, userId]
);
```

---

## Vector Extension

Store and search vector embeddings for AI applications.

### Installation

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteExtensions: ["vector"],
  schemaSQL: [
    `CREATE TABLE documents (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding VECTOR(384) -- 384-dimensional vector
    )`,
    
    // Create index for fast similarity search
    `CREATE INDEX documents_embedding_idx 
     ON documents 
     USING ivfflat (embedding vector_cosine_ops)`
  ]
});
```

### Vector Operations

#### Store Vectors

```typescript
// Vector as string
await db.query(
  "INSERT INTO documents (title, content, embedding) VALUES ($1, $2, $3::vector)",
  ["Hello World", "This is content", "[0.1, 0.2, 0.3, ...]"]
);

// Vector as array (converted to string)
const embedding = [0.1, 0.2, 0.3]; // ... 384 dimensions
await db.query(
  "INSERT INTO documents (title, embedding) VALUES ($1, $2::vector)",
  ["Document", JSON.stringify(embedding)]
);
```

#### Similarity Search

**Cosine Distance (`<=>`)**:
```typescript
const searchVector = "[0.1, 0.2, 0.3, ...]";

const results = await db.query(`
  SELECT 
    title,
    embedding <=> $1::vector as distance
  FROM documents
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> $1::vector
  LIMIT 5
`, [searchVector]);

// Smaller distance = more similar
results.rows.forEach(row => {
  console.log(`${row.title}: ${row.distance}`);
});
```

**Euclidean Distance (`<->`)**:
```typescript
const results = await db.query(`
  SELECT title, embedding <-> $1::vector as distance
  FROM documents
  ORDER BY embedding <-> $1::vector
  LIMIT 5
`, [searchVector]);
```

**Inner Product (`<#>`)**:
```typescript
const results = await db.query(`
  SELECT title, embedding <#> $1::vector as distance
  FROM documents
  ORDER BY embedding <#> $1::vector
  LIMIT 5
`, [searchVector]);
```

### Use Cases

**Semantic Search:**
```typescript
// 1. Store document embeddings
async function indexDocument(title: string, content: string) {
  // Get embedding from AI model (e.g., OpenAI)
  const embedding = await getEmbedding(content);
  
  await db.query(
    "INSERT INTO documents (title, content, embedding) VALUES ($1, $2, $3::vector)",
    [title, content, JSON.stringify(embedding)]
  );
}

// 2. Search by meaning
async function semanticSearch(query: string, limit = 5) {
  const queryEmbedding = await getEmbedding(query);
  
  const results = await db.query(`
    SELECT title, content, embedding <=> $1::vector as score
    FROM documents
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `, [JSON.stringify(queryEmbedding), limit]);
  
  return results.rows;
}

// Usage
await indexDocument("PostgreSQL Guide", "PostgreSQL is a powerful database...");
await indexDocument("Redis Tutorial", "Redis is an in-memory data store...");

const results = await semanticSearch("How to use databases?");
// Returns most semantically similar documents
```

**Recommendation System:**
```typescript
// Find similar products
const product = await db.query(
  "SELECT embedding FROM products WHERE id = $1",
  [productId]
);

const similar = await db.query(`
  SELECT id, name, embedding <=> $1::vector as similarity
  FROM products
  WHERE id != $2
  ORDER BY embedding <=> $1::vector
  LIMIT 10
`, [product.rows[0].embedding, productId]);
```

**Image Search:**
```typescript
// Store image embeddings
await db.query(
  "INSERT INTO images (url, embedding) VALUES ($1, $2::vector)",
  [imageUrl, JSON.stringify(imageEmbedding)]
);

// Find similar images
const similar = await db.query(`
  SELECT url, embedding <=> $1::vector as distance
  FROM images
  ORDER BY embedding <=> $1::vector
  LIMIT 20
`, [queryEmbedding]);
```

---

## PostGIS Extension

Work with geographic data and spatial queries.

### Installation

```typescript
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteExtensions: ["postgis"],
  schemaSQL: [
    `CREATE TABLE locations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      position GEOMETRY(Point, 4326)
    )`,
    
    // Spatial index
    `CREATE INDEX locations_position_idx 
     ON locations 
     USING GIST (position)`
  ]
});
```

### Geometric Operations

#### Store Points

```typescript
// Store latitude/longitude
await db.query(`
  INSERT INTO locations (name, position) 
  VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326))
`, ["San Francisco", -122.4194, 37.7749]); // lng, lat
```

#### Distance Queries

```typescript
// Find nearby locations (within 10km)
const results = await db.query(`
  SELECT 
    name,
    ST_Distance(
      position::geography,
      ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
    ) as distance_meters
  FROM locations
  WHERE ST_DWithin(
    position::geography,
    ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
    10000 -- 10km in meters
  )
  ORDER BY distance_meters
`, [longitude, latitude]);
```

#### Area Queries

```typescript
// Find locations within a polygon
await db.query(`
  SELECT name
  FROM locations
  WHERE ST_Within(
    position,
    ST_GeomFromText('POLYGON((...))', 4326)
  )
`);
```

### Use Cases

**Store Locator:**
```typescript
async function findNearbyStores(lat: number, lng: number, radiusKm: number) {
  return await db.query(`
    SELECT 
      id,
      name,
      ST_Distance(
        position::geography,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
      ) / 1000 as distance_km
    FROM stores
    WHERE ST_DWithin(
      position::geography,
      ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
      $3 * 1000
    )
    ORDER BY distance_km
    LIMIT 10
  `, [lng, lat, radiusKm]);
}
```

**Delivery Zones:**
```typescript
async function isInDeliveryZone(lat: number, lng: number) {
  const result = await db.query(`
    SELECT EXISTS(
      SELECT 1 FROM delivery_zones
      WHERE ST_Within(
        ST_SetSRID(ST_MakePoint($1, $2), 4326),
        zone_polygon
      )
    ) as in_zone
  `, [lng, lat]);
  
  return result.rows[0].in_zone;
}
```

---

## Custom Extensions

### Check Extension Availability

```typescript
async function checkExtension(name: string): Promise<boolean> {
  try {
    await db.query(`CREATE EXTENSION IF NOT EXISTS ${name}`);
    return true;
  } catch (error) {
    return false;
  }
}

const hasUUID = await checkExtension("uuid_ossp");
const hasVector = await checkExtension("vector");

console.log({ hasUUID, hasVector });
```

### Conditional Features

```typescript
class FeatureFlags {
  hasUUID = false;
  hasVector = false;
  
  async detect(db: Ominipg) {
    try {
      await db.query("SELECT uuid_generate_v4()");
      this.hasUUID = true;
    } catch {}
    
    try {
      await db.query("SELECT '[1,2,3]'::vector");
      this.hasVector = true;
    } catch {}
  }
}

const features = new FeatureFlags();
await features.detect(db);

// Use features conditionally
if (features.hasUUID) {
  // Use UUID
} else {
  // Fallback to SERIAL
}
```

---

## Troubleshooting

### Extension Not Loading

**Problem:** Extension functions don't work

**Solutions:**
```typescript
// 1. Verify PGlite is being used
const info = await db.getDiagnosticInfo();
console.log(info.mainDatabase.type); // Should be "pglite"

// 2. Check extension is in the list
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteExtensions: ["uuid_ossp"], // ✅ Correct
  // pgliteExtensions: ["uuid-ossp"], // ❌ Wrong name
});

// 3. Test extension manually
try {
  await db.query("CREATE EXTENSION IF NOT EXISTS uuid_ossp");
  console.log("Extension available");
} catch (error) {
  console.error("Extension not available:", error);
}
```

### Wrong Vector Dimensions

**Problem:** `Vector dimension mismatch`

**Solution:** Ensure vector dimensions match schema:
```typescript
// Schema declares 384 dimensions
`CREATE TABLE docs (embedding VECTOR(384))`

// ❌ Wrong: 3 dimensions
await db.query("INSERT INTO docs (embedding) VALUES ('[1,2,3]'::vector)");

// ✅ Correct: 384 dimensions
const embedding = new Array(384).fill(0);
await db.query("INSERT INTO docs (embedding) VALUES ($1::vector)", 
  [JSON.stringify(embedding)]
);
```

### Performance Issues

**Problem:** Slow vector search

**Solutions:**
```typescript
// 1. Create index
await db.query(`
  CREATE INDEX docs_embedding_idx 
  ON documents 
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100) -- Tune this based on data size
`);

// 2. Use appropriate distance operator
// Cosine: <=> (most common for embeddings)
// Euclidean: <->
// Inner product: <#>

// 3. Limit results
await db.query(`
  SELECT * FROM documents
  ORDER BY embedding <=> $1::vector
  LIMIT 10 -- Don't fetch all results
`, [queryVector]);
```

---

## Complete Example

```typescript
import { Ominipg } from "jsr:@oxian/ominipg";

// Load multiple extensions
const db = await Ominipg.connect({
  url: ":memory:",
  pgliteExtensions: ["uuid_ossp", "vector"],
  schemaSQL: [
    `CREATE TABLE products (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name TEXT NOT NULL,
      description TEXT,
      price DECIMAL(10,2),
      embedding VECTOR(384),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    
    `CREATE INDEX products_embedding_idx 
     ON products 
     USING ivfflat (embedding vector_cosine_ops)`
  ]
});

// Insert with UUID and vector
const embedding = new Array(384).fill(0).map(() => Math.random());

await db.query(`
  INSERT INTO products (name, description, price, embedding)
  VALUES ($1, $2, $3, $4::vector)
`, [
  "Laptop",
  "High-performance laptop for developers",
  1299.99,
  JSON.stringify(embedding)
]);

// Search similar products
const queryEmbedding = new Array(384).fill(0).map(() => Math.random());

const similar = await db.query(`
  SELECT 
    id,
    name,
    price,
    embedding <=> $1::vector as similarity
  FROM products
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> $1::vector
  LIMIT 5
`, [JSON.stringify(queryEmbedding)]);

console.log("Similar products:", similar.rows);

await db.close();
```

---

## See Also

- [PGlite Extensions](https://github.com/electric-sql/pglite#extensions)
- [pgvector Documentation](https://github.com/pgvector/pgvector)
- [PostGIS Documentation](https://postgis.net/)
- [API Reference](./API.md)
- [Examples](../examples/pglite-extensions.ts)

