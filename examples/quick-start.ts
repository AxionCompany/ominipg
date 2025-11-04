/**
 * Quick Start Example - Try Ominipg in 30 seconds!
 *
 * Run this with: deno run --allow-all https://deno.land/x/ominipg/examples/quick-start.ts
 */

import { Ominipg } from "../src/client/index.ts";

console.log("🐘 Ominipg Quick Start Demo\n");

// 1. Connect to an in-memory database
console.log("📖 Creating in-memory database...");
const db = await Ominipg.connect({
  url: ":memory:",
  schemaSQL: [
    `CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  ],
});

console.log("✅ Database connected!\n");

// 2. Insert some data
console.log("💾 Inserting users...");
await db.query("INSERT INTO users (name, email) VALUES ($1, $2)", [
  "Alice",
  "alice@example.com",
]);
await db.query("INSERT INTO users (name, email) VALUES ($1, $2)", [
  "Bob",
  "bob@example.com",
]);
await db.query("INSERT INTO users (name, email) VALUES ($1, $2)", [
  "Charlie",
  "charlie@example.com",
]);

// 3. Query the data
console.log("🔍 Querying users...");
const allUsers = await db.query("SELECT * FROM users ORDER BY id");
console.log("All users:", allUsers.rows);

const userCount = await db.query("SELECT COUNT(*) as total FROM users");
console.log(`\n📊 Total users: ${userCount.rows[0].total}`);

// 4. Update some data
console.log("\n✏️ Updating Alice's email...");
await db.query("UPDATE users SET email = $1 WHERE name = $2", [
  "alice.doe@example.com",
  "Alice",
]);

const updatedUser = await db.query("SELECT * FROM users WHERE name = $1", [
  "Alice",
]);
console.log("Updated Alice:", updatedUser.rows[0]);

// 5. Show diagnostic info
console.log("\n🔧 Database info:");
const info = await db.getDiagnosticInfo();
console.log("Type:", info.mainDatabase.type);
console.log("Tables:", info.trackedTables);

console.log(
  "\n🎉 Done! Try adding Drizzle ORM with the withDrizzle() helper for type-safe queries.",
);

await db.close();
