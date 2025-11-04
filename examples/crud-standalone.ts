/**
 * Standalone CRUD Example
 * 
 * This example shows how to use the CRUD module independently
 * with any database library (postgres.js, pg, Deno.postgres, etc.)
 * 
 * Run this with: deno run --allow-all examples/crud-standalone.ts
 */

import { Pool } from "npm:pg@8.16.3";
import { defineSchema, createCrudApi } from "../src/client/crud/index.ts";

console.log("🔌 Standalone CRUD Module Demo\n");

// 1. Setup your database connection (using node-postgres as example)
console.log("📖 Connecting to PostgreSQL...");
const pool = new Pool({
  // Use in-memory SQLite for demo, or replace with your PostgreSQL connection
  connectionString: "postgresql://postgres:postgres@localhost:5432/test",
});

// Create test table
await pool.query(`
  DROP TABLE IF EXISTS products;
  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    in_stock BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

console.log("✅ Database connected!\n");

// 2. Define your schemas using JSON Schema
console.log("📝 Defining schemas...");
const schemas = defineSchema({
  products: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        category: { type: "string" },
        price: { type: "number" },
        in_stock: { type: "boolean" },
        created_at: { type: "string" },
        updated_at: { type: "string" },
      },
      required: ["id", "name", "category", "price"],
    },
    keys: [{ property: "id" }],
    timestamps: true,
  },
});

// 3. Type inference - no imports needed!
type Product = typeof schemas.products.$inferSelect;
type NewProduct = typeof schemas.products.$inferInsert;

console.log("✅ Schemas defined with full type inference!\n");

// 4. Create query function for your database
async function queryFn(sql: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params ?? []);
    return { rows: result.rows as unknown[] };
  } finally {
    client.release();
  }
}

// 5. Create CRUD API
const crud = createCrudApi(schemas, queryFn);
console.log("✅ CRUD API created!\n");

// 6. Use the CRUD API with full type safety
console.log("💾 Creating products...");

const laptop: NewProduct = {
  id: "prod_1",
  name: "MacBook Pro",
  category: "Laptops",
  price: 2499.99,
  in_stock: true,
};

const mouse = {
  id: "prod_2",
  name: "Magic Mouse",
  category: "Accessories",
  price: 79.99,
  in_stock: true,
} satisfies NewProduct;

const keyboard = {
  id: "prod_3",
  name: "Magic Keyboard",
  category: "Accessories",
  price: 149.99,
  in_stock: false,
} satisfies NewProduct;

// Create single product
const createdLaptop = await crud.products.create(laptop);
console.log("✓ Created:", createdLaptop.name);

// Create multiple products
const createdProducts = await crud.products.createMany([mouse, keyboard]);
console.log(`✓ Created ${createdProducts.length} more products`);

// 7. Query with filters
console.log("\n🔍 Querying products...");

// Find all products
const allProducts = await crud.products.find();
console.log(`All products (${allProducts.length}):`);
allProducts.forEach((p: Product) => {
  console.log(`  - ${p.name} (${p.category}): $${p.price}`);
});

// Find with filter - expensive products
console.log("\nExpensive products (>$100):");
const expensiveProducts = await crud.products.find({
  price: { $gt: 100 },
});
expensiveProducts.forEach((p: Product) => {
  console.log(`  - ${p.name}: $${p.price}`);
});

// Find with multiple filters
console.log("\nIn-stock accessories:");
const inStockAccessories = await crud.products.find({
  category: "Accessories",
  in_stock: true,
});
inStockAccessories.forEach((p: Product) => {
  console.log(`  - ${p.name}: $${p.price}`);
});

// Find one
console.log("\nFind specific product:");
const specificProduct = await crud.products.findOne({ id: "prod_1" });
if (specificProduct) {
  console.log(`  Found: ${specificProduct.name}`);
}

// 8. Update products
console.log("\n✏️ Updating products...");

const updated = await crud.products.update(
  { id: "prod_3" },
  { in_stock: true },
);
if (updated) {
  console.log(`✓ Updated "${updated.name}" is now in stock`);
}

// 9. Query with options
console.log("\n📊 Query with options:");

// Sort by price descending
const sortedProducts = await crud.products.find(
  {},
  {
    sort: [{ field: "price", direction: "desc" }],
    limit: 2,
  },
);

console.log("Top 2 most expensive products:");
sortedProducts.forEach((p: Product) => {
  console.log(`  - ${p.name}: $${p.price}`);
});

// Select specific fields
const names = await crud.products.find(
  {},
  {
    select: ["id", "name", "price"],
    sort: [{ field: "name", direction: "asc" }],
  },
);

console.log("\nProducts (name and price only):");
names.forEach((p) => {
  console.log(`  - ${p.name}: $${p.price}`);
});

// 10. Delete products
console.log("\n🗑️ Deleting out-of-stock products...");

// First, mark one as out of stock
await crud.products.update(
  { id: "prod_2" },
  { in_stock: false },
);

const deleteResult = await crud.products.deleteMany({
  in_stock: false,
});

console.log(`✓ Deleted ${deleteResult.count} product(s)`);

// 11. Final count
const remaining = await crud.products.find();
console.log(`\n📊 Remaining products: ${remaining.length}`);

// 12. Upsert example
console.log("\n🔄 Upsert example:");

await crud.products.update(
  { id: "prod_1" },
  {
    id: "prod_1",
    name: "MacBook Pro 16-inch",
    category: "Laptops",
    price: 2799.99,
  },
  { upsert: true },
);

const upserted = await crud.products.findOne({ id: "prod_1" });
console.log(`✓ Upserted: ${upserted?.name} - $${upserted?.price}`);

// Cleanup
console.log("\n🧹 Cleaning up...");
await pool.end();

console.log("\n🎉 Done! Standalone CRUD module works with any database library.");
console.log("💡 Key benefits:");
console.log("   - Use with postgres.js, pg, or any other library");
console.log("   - Full type safety with TypeScript");
console.log("   - MongoDB-like query syntax");
console.log("   - Runtime validation with Zod");
console.log("   - No vendor lock-in!");

