import { Ominipg, withDrizzle } from "../src/client/index.ts";
import { drizzle } from "npm:drizzle-orm/pg-proxy";
import { integer, pgTable, serial, varchar } from "npm:drizzle-orm/pg-core";
import { assertEquals, assertExists } from "jsr:@std/assert";

// Example schema definition using Drizzle
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }),
  age: integer("age"),
});

const schemaDDL = [
  `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        age INTEGER
    )`,
];

Deno.test("withDrizzle - explicit drizzle factory", async () => {
  // 1. Connect to Ominipg
  const ominipg = await Ominipg.connect({
    url: ":memory:",
    schemaSQL: schemaDDL,
    pgliteExtensions: ["uuid_ossp", "vector", "pg_trgm"],
    logMetrics: true,
  });

  // 2. Create Drizzle adapter using explicit factory
  const db = withDrizzle(ominipg, drizzle, { users });

  // 3. Test that the adapter has both Drizzle and Ominipg methods
  assertExists(db.query, "Should have Drizzle query method");
  assertExists(db.select, "Should have Drizzle select method");
  assertExists(db.insert, "Should have Drizzle insert method");
  assertExists(db.sync, "Should have Ominipg sync method");
  assertExists(db.queryRaw, "Should have Ominipg queryRaw method");
  assertExists(
    db._ominipg,
    "Should have access to underlying Ominipg instance",
  );

  // 4. Test inserting data using Drizzle syntax
  await db.insert(users).values({ name: "Alice", age: 30 });

  const manyQuery = await db.query.users.findMany({
    where: (users, { eq }) => eq(users.id, 1),
  });

  // 5. Test querying using Drizzle syntax
  const result = await db.select().from(users);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "Alice");
  assertEquals(result[0].age, 30);

  // 6. Test raw query access
  const rawResult = await db.queryRaw("SELECT COUNT(*) as count FROM users");
  assertEquals(rawResult.rows[0].count, 1);

  await ominipg.close();
});
