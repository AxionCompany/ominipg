/**
 * PGlite Extensions Example
 * 
 * This example demonstrates how to use PGlite extensions with Ominipg.
 * Extensions are dynamically loaded and included when using PGlite (not PostgreSQL).
 * 
 * Run this with: deno run --allow-all examples/pglite-extensions.ts
 */

import { Ominipg } from '../src/client/index.ts';

console.log('🔌 Ominipg PGlite Extensions Demo\n');

// 1. Connect with basic schema first, then test extensions
console.log('📦 Loading PGlite with extensions...');
const db = await Ominipg.connect({
  url: ':memory:', // Use in-memory PGlite database
  pgliteExtensions: ['uuid_ossp', 'vector'], // Load UUID and vector extensions
  schemaSQL: [
    // Create basic tables first without extension-dependent types
    `CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      price DECIMAL(10,2),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    
    `CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      product_id TEXT REFERENCES products(id),
      customer_name TEXT NOT NULL,
      order_date TIMESTAMPTZ DEFAULT NOW()
    )`
  ]
});

console.log('✅ Database connected with extensions loaded!\n');

// 2. Test extension availability
console.log('🔍 Testing extension functions...');

// Test UUID extension
let uuidAvailable = false;
try {
  const uuidTest = await db.query('SELECT uuid_generate_v4() as test_uuid');
  console.log('✓ UUID extension is working!');
  console.log('Sample UUID:', uuidTest.rows[0].test_uuid);
  uuidAvailable = true;
} catch (error) {
  console.log('✗ UUID extension not available:', error.message);
}

// Test Vector extension
let vectorAvailable = false;
try {
  await db.query("SELECT '[1,2,3]'::vector as test_vector");
  console.log('✓ Vector extension is working!');
  vectorAvailable = true;
  
  // Add vector column and index if vector extension works
  await db.query('ALTER TABLE products ADD COLUMN embedding VECTOR(3)');
  await db.query('CREATE INDEX products_embedding_idx ON products USING ivfflat (embedding vector_cosine_ops)');
  console.log('✓ Added vector column and index to products table');
} catch (error) {
  console.log('✗ Vector extension not available:', error.message);
  console.log('  Continuing without vector functionality...');
}

// 3. Insert data with extensions (if available)
console.log('\n💾 Inserting products...');

const products = [
  ['Laptop', 'High-performance laptop for development', 'Electronics', 1299.99, '[0.1, 0.2, 0.3]'],
  ['Mouse', 'Wireless optical mouse with ergonomic design', 'Electronics', 29.99, '[0.4, 0.5, 0.6]'],
  ['Keyboard', 'Mechanical gaming keyboard with RGB lighting', 'Electronics', 149.99, '[0.7, 0.8, 0.9]']
];

for (let i = 0; i < products.length; i++) {
  const [name, description, category, price, embedding] = products[i];
  
  // Generate ID using UUID extension if available, otherwise use manual ID
  const id = uuidAvailable 
    ? (await db.query('SELECT uuid_generate_v4()::text as id')).rows[0].id
    : `product_${i + 1}`;
  
  // Insert with vector if available
  if (vectorAvailable) {
    await db.query(`
      INSERT INTO products (id, name, description, category, price, embedding) 
      VALUES ($1, $2, $3, $4, $5, $6::vector)
    `, [id, name, description, category, price, embedding]);
  } else {
    await db.query(`
      INSERT INTO products (id, name, description, category, price) 
      VALUES ($1, $2, $3, $4, $5)
    `, [id, name, description, category, price]);
  }
}

console.log(`✓ Inserted ${products.length} products`);

// 4. Query products
console.log('\n🔍 Querying products...');
const selectQuery = vectorAvailable 
  ? 'SELECT id, name, description, price, embedding FROM products ORDER BY name'
  : 'SELECT id, name, description, price FROM products ORDER BY name';

const allProducts = await db.query(selectQuery);
console.log('Products:');
allProducts.rows.forEach(product => {
  console.log(`  📦 ${product.name} (ID: ${product.id})`);
  console.log(`      Description: ${product.description}`);
  console.log(`      Price: $${product.price}`);
  if (product.embedding) {
    console.log(`      Embedding: ${product.embedding}`);
  }
});

// 5. Demonstrate vector similarity search (if available)
if (vectorAvailable) {
  console.log('\n🔍 Vector Similarity Search:');
  const searchVector = '[0.1, 0.2, 0.4]';
  
  try {
    const similarProducts = await db.query(`
      SELECT name, description, embedding,
             (embedding <=> $1::vector) as distance
      FROM products 
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT 2
    `, [searchVector]);

    console.log(`Products similar to vector ${searchVector}:`);
    similarProducts.rows.forEach(product => {
      console.log(`  📦 ${product.name} (distance: ${product.distance})`);
      console.log(`      Embedding: ${product.embedding}`);
    });
  } catch (error) {
    console.log('Vector search failed:', error.message);
  }
} else {
  console.log('\n⚠ Vector similarity search not available (vector extension not loaded)');
}

// 6. Demonstrate UUID functions if available
if (uuidAvailable) {
  console.log('\n🆔 UUID Functions Demo:');
  try {
    const uuidDemo = await db.query(`
      SELECT 
        uuid_generate_v4() as uuid_v4,
        uuid_nil() as nil_uuid
    `);
    
    console.log('✓ UUID Functions Available:');
    const row = uuidDemo.rows[0];
    console.log(`  UUID v4: ${row.uuid_v4}`);
    console.log(`  Nil UUID: ${row.nil_uuid}`);
    
    // Generate a few more UUIDs
    console.log('  Additional UUIDs:');
    for (let i = 0; i < 3; i++) {
      const result = await db.query('SELECT uuid_generate_v4() as uuid');
      console.log(`    ${i + 1}: ${result.rows[0].uuid}`);
    }
    
  } catch (error) {
    console.log('✗ Some UUID functions not available:', error.message);
  }
} else {
  console.log('\n⚠ UUID functions not available (uuid-ossp extension not working)');
}

// 7. Create orders
console.log('\n📝 Creating orders...');
const firstProduct = allProducts.rows[0];

const orderId = uuidAvailable 
  ? (await db.query('SELECT uuid_generate_v4()::text as id')).rows[0].id
  : 'order_1';

await db.query(`
  INSERT INTO orders (id, product_id, customer_name) 
  VALUES ($1, $2, $3)
`, [orderId, firstProduct.id, 'Alice Johnson']);

console.log('✓ Order created successfully');

// 8. Query orders with JOINs
console.log('\n🔍 Querying orders with product details...');
const orders = await db.query(`
  SELECT 
    o.id as order_id,
    o.customer_name,
    o.order_date,
    p.name as product_name,
    p.price
  FROM orders o
  JOIN products p ON o.product_id = p.id
  ORDER BY o.order_date DESC
`);

console.log('Orders:');
orders.rows.forEach(order => {
  console.log(`  📋 Order ${order.order_id}`);
  console.log(`      Customer: ${order.customer_name}`);
  console.log(`      Product: ${order.product_name} ($${order.price})`);
  console.log(`      Date: ${order.order_date}`);
});

// 9. Show diagnostic info
console.log('\n🔧 Database diagnostic info:');
const info = await db.getDiagnosticInfo();
console.log('Database type:', info.mainDatabase.type);
console.log('Tracked tables:', info.trackedTables);

// 10. Summary
console.log('\n📊 Extension Status Summary:');
console.log(`  UUID (uuid-ossp): ${uuidAvailable ? '✓ Working' : '✗ Not available'}`);
console.log(`  Vector (pgvector): ${vectorAvailable ? '✓ Working' : '✗ Not available'}`);

console.log('\n🎉 PGlite extensions demo completed!');
console.log('💡 Tip: Extensions are only loaded when using PGlite, not PostgreSQL.');
console.log('💡 This example gracefully handles cases where extensions are not available.');
console.log('💡 Extension availability depends on the PGlite version and build configuration.');

await db.close(); 