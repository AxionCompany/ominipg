import { drizzle } from 'npm:drizzle-orm/pg-proxy';
import { pgTable, serial, varchar, integer } from 'npm:drizzle-orm/pg-core';
import { Ominipg } from '../src/client/index.ts';

// Mock Ominipg instance for testing
const ominipg = await Ominipg.connect({
    url: '', // Empty string for in-memory PGlite
    schemaSQL: [
        `CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100),
            age INTEGER
        )`
    ]
});

// Create Drizzle instance using the proxy pattern
const db = drizzle(async (sql, params, method) => {
    try {
        console.log(sql, params, method);
        const result = await ominipg.query(sql, params);
        return { rows: result.rows };
    } catch (e: any) {
        console.error('Error from pg proxy server: ', e);
        return { rows: [] };
    }
});

// Define a simple users table schema
export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 100 }),
    age: integer('age'),
});

// Example: Create table (DDL) - already done in connection options
async function createUsersTable() {
    // Table is already created via schemaSQL in connection options
    console.log('Table created via schemaSQL');
}

// Example: Insert a user
async function insertUser(name: string, age: number) {
    await db.insert(users).values({ name, age });
}

// Example: Select users
async function getUsers() {
    const allUsers = await db.select().from(users);
    console.log('All users:', allUsers);
}

// Example usage
(async () => {
    await createUsersTable();
    await insertUser('Alice', 30);
    await insertUser('Bob', 25);
    await getUsers();
    await ominipg.close();
})();
