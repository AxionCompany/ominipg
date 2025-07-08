/**
 * Example: Using the built-in withDrizzle helper
 * 
 * This shows the simplest way to use Drizzle with Ominipg using the 
 * built-in helper function.
 */

import { Ominipg, withDrizzle } from '../src/client/index.ts';
import { pgTable, serial, varchar, integer, timestamp } from 'npm:drizzle-orm/pg-core';
import { lt } from 'npm:drizzle-orm';

// Example schema definition using Drizzle
export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 100 }),
    age: integer('age'),
    created_at: timestamp('created_at').defaultNow(),
});

export const schemaDDL = [
    `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        age INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`
];

// Example usage
export async function example() {
    // 1. Connect to Ominipg (ORM-agnostic)
    const ominipg = await Ominipg.connect({
        url: ':memory:', // In-memory database for demo
        schemaSQL: schemaDDL,
    });

    // 2. Create Drizzle adapter using the built-in helper
    // Auto-import version (async)
    const db = await withDrizzle(ominipg, { users });
    
    // 3. Use Drizzle syntax
    await db.insert(users).values({ name: 'Alice', age: 30 });
    await db.insert(users).values({ name: 'Bob', age: 25 });
    
    // Query with Drizzle
    const allUsers = await db.select().from(users);
    console.log('All users:', allUsers);
    
    // Filter with Drizzle
    const youngUsers = await db.select().from(users).where(lt(users.age, 30));
    console.log('Young users:', youngUsers);

    // Raw query is still available
    const count = await db.queryRaw('SELECT COUNT(*) as total FROM users');
    console.log('Total users:', count.rows[0].total);

    // Ominipg-specific methods work too
    const diagnostic = await db.getDiagnosticInfo();
    console.log('Database info:', diagnostic);
    
    await db.close();
}

// Run the example if this file is executed directly
if (import.meta.main) {
    await example();
} 