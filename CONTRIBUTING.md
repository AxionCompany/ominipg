# Contributing to Ominipg

Thank you for your interest in contributing to Ominipg! We welcome contributions from the community.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Running Tests](#running-tests)
- [Making Changes](#making-changes)
- [Submitting Pull Requests](#submitting-pull-requests)
- [Coding Guidelines](#coding-guidelines)
- [Documentation](#documentation)

---

## Code of Conduct

We are committed to providing a welcoming and inclusive environment. Please be respectful and constructive in all interactions.

---

## Getting Started

### Prerequisites

- **Deno** 2.x or higher
- **Git**
- **PostgreSQL** (optional, for testing remote features)

### Fork and Clone

```bash
# Fork the repository on GitHub first, then:
git clone https://github.com/copilotzhq/ominipg.git
cd ominipg
```

---

## Development Setup

### Install Deno

```bash
# macOS/Linux
curl -fsSL https://deno.land/install.sh | sh

# Windows (PowerShell)
irm https://deno.land/install.ps1 | iex
```

### Verify Installation

```bash
deno --version
```

---

## Project Structure

```
ominipg/
├── src/
│   ├── client/           # Client-side code (main thread)
│   │   ├── crud/         # CRUD API implementation
│   │   │   ├── index.ts       # Main CRUD logic
│   │   │   ├── schema.ts      # Schema processing
│   │   │   ├── filter.ts      # Filter compiler
│   │   │   ├── types.ts       # Type definitions
│   │   │   └── defineTable.ts # Schema helpers
│   │   ├── index.ts      # Main Ominipg class
│   │   └── types.ts      # Client types
│   │
│   ├── worker/           # Worker thread code
│   │   ├── sync/         # Sync mechanism
│   │   │   ├── manager.ts     # Sync orchestration
│   │   │   ├── pusher.ts      # Push to remote
│   │   │   ├── puller.ts      # Pull from remote
│   │   │   ├── sequences.ts   # Sequence sync
│   │   │   └── initial.ts     # Initial setup
│   │   ├── index.ts      # Worker entry point
│   │   ├── db.ts         # Database abstraction
│   │   ├── bootstrap.ts  # Worker initialization
│   │   ├── schema.ts     # Schema management
│   │   ├── diagnostics.ts # Diagnostic info
│   │   └── utils.ts      # Utilities
│   │
│   └── shared/           # Shared types
│       └── types.ts      # Message types
│
├── test/                 # Test files
│   ├── crud.test.ts      # CRUD API tests
│   ├── integration.test.ts     # Integration tests
│   ├── integration-remote.test.ts
│   ├── with-drizzle.test.ts
│   ├── direct-mode.test.ts
│   ├── worker-overhead.test.ts
│   └── worker-pg-nosync.test.ts
│
├── examples/             # Example code
│   ├── quick-start.ts
│   ├── with-drizzle-simple.ts
│   └── pglite-extensions.ts
│
├── docs/                 # Documentation
│   ├── API.md
│   ├── CRUD.md
│   ├── DRIZZLE.md
│   ├── SYNC.md
│   ├── EXTENSIONS.md
│   └── ARCHITECTURE.md
│
├── deno.json            # Deno configuration
├── README.md
├── ROADMAP.md
├── LICENSE
└── CONTRIBUTING.md
```

---

## Running Tests

### Run All Tests

```bash
deno test --allow-all
```

### Run Specific Test File

```bash
deno test --allow-all test/crud.test.ts
```

### Run with Coverage

```bash
deno test --allow-all --coverage=coverage
deno coverage coverage
```

### Run with Watch Mode

```bash
deno test --allow-all --watch
```

---

## Making Changes

### 1. Create a Branch

```bash
git checkout -b feature/my-new-feature
# or
git checkout -b fix/issue-123
```

Branch naming conventions:
- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `refactor/` - Code refactoring
- `test/` - Test improvements

### 2. Make Your Changes

- Write clean, readable code
- Follow existing code style
- Add tests for new features
- Update documentation as needed

### 3. Test Your Changes

```bash
# Run tests
deno test --allow-all

# Run examples to verify
deno run --allow-all examples/quick-start.ts
deno run --allow-all examples/with-drizzle-simple.ts
```

### 4. Commit Your Changes

Use clear, descriptive commit messages:

```bash
git add .
git commit -m "feat: add support for custom validators in CRUD API"

# Or for bug fixes
git commit -m "fix: resolve race condition in sync manager"
```

Commit message format:
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only
- `style:` - Code style changes
- `refactor:` - Code refactoring
- `test:` - Adding/updating tests
- `chore:` - Maintenance tasks

---

## Submitting Pull Requests

### 1. Push Your Branch

```bash
git push origin feature/my-new-feature
```

### 2. Create Pull Request

1. Go to GitHub repository
2. Click "Pull Requests" → "New Pull Request"
3. Select your branch
4. Fill in PR template:
   - **Title**: Clear, concise description
   - **Description**: What changes were made and why
   - **Related Issues**: Link to related issues
   - **Testing**: How you tested the changes

### 3. PR Checklist

Before submitting, ensure:

- [ ] Tests pass (`deno test --allow-all`)
- [ ] Code follows project style
- [ ] New features have tests
- [ ] Documentation is updated
- [ ] Examples work correctly
- [ ] No linter errors
- [ ] Commit messages are clear

### 4. Review Process

- Maintainers will review your PR
- Address any feedback
- Make requested changes
- Once approved, PR will be merged

---

## Coding Guidelines

### TypeScript Style

```typescript
// ✅ Good: Use descriptive names
async function syncLocalChangesToRemote(): Promise<{ pushed: number }> {
  // ...
}

// ❌ Bad: Unclear names
async function sync2(): Promise<any> {
  // ...
}

// ✅ Good: Explicit types
interface User {
  id: string;
  name: string;
  email: string;
}

// ❌ Bad: Using 'any'
interface User {
  [key: string]: any;
}

// ✅ Good: Async/await
async function fetchUser(id: string): Promise<User> {
  const result = await db.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0];
}

// ❌ Bad: Promise chains
function fetchUser(id: string): Promise<User> {
  return db.query("SELECT * FROM users WHERE id = $1", [id])
    .then(result => result.rows[0]);
}
```

### Error Handling

```typescript
// ✅ Good: Specific error messages
if (!schema) {
  throw new Error(`Schema not found for table: ${tableName}`);
}

// ❌ Bad: Generic errors
if (!schema) {
  throw new Error("Error");
}

// ✅ Good: Handle errors appropriately
try {
  await db.sync();
} catch (error) {
  console.error("Sync failed:", error);
  // Emit error event or rethrow with context
  throw new Error(`Sync failed: ${error.message}`);
}
```

### Comments

```typescript
// ✅ Good: Explain why, not what
// Use optimistic locking to prevent concurrent updates
const version = row.version + 1;

// ❌ Bad: Obvious comments
// Increment version
const version = row.version + 1;

// ✅ Good: Document complex logic
/**
 * Converts MongoDB-style filter to SQL WHERE clause.
 * 
 * Supports operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $like, etc.
 * Handles nested objects, arrays, and logical operators ($and, $or, $not).
 * 
 * @param filter - MongoDB-style filter object
 * @returns Object with SQL WHERE clause and parameters
 */
function compileFilter(filter: Filter): { sql: string; params: unknown[] } {
  // ...
}
```

### Testing

```typescript
// ✅ Good: Descriptive test names
Deno.test("CRUD API: find() should filter records with $gte operator", async () => {
  // ...
});

// ❌ Bad: Unclear test names
Deno.test("test 1", async () => {
  // ...
});

// ✅ Good: Arrange-Act-Assert pattern
Deno.test("CRUD API: create() should validate required fields", async () => {
  // Arrange
  const db = await setupTestDb();
  const invalidUser = { name: "Alice" }; // Missing required 'email'
  
  // Act & Assert
  await assertRejects(
    () => db.crud.users.create(invalidUser),
    Error,
    "email is required"
  );
  
  // Cleanup
  await db.close();
});
```

---

## Documentation

### Code Documentation

Use JSDoc comments for public APIs:

```typescript
/**
 * Execute a SQL query.
 * 
 * @param sql - SQL query string with optional placeholders ($1, $2, etc.)
 * @param params - Optional parameters to bind to placeholders
 * @returns Promise resolving to query result with rows
 * 
 * @example
 * ```typescript
 * const result = await db.query(
 *   "SELECT * FROM users WHERE age > $1",
 *   [18]
 * );
 * console.log(result.rows);
 * ```
 */
async query<TRow extends Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<{ rows: TRow[] }> {
  // ...
}
```

### README and Docs

When updating documentation:

1. **README.md** - High-level overview and quick start
2. **docs/API.md** - Complete API reference
3. **docs/CRUD.md** - CRUD API guide
4. **docs/DRIZZLE.md** - Drizzle integration
5. **docs/SYNC.md** - Sync functionality
6. **docs/EXTENSIONS.md** - Extensions guide
7. **docs/ARCHITECTURE.md** - Architecture details

Keep docs:
- Clear and concise
- Up-to-date with code
- Full of practical examples
- Easy to navigate

---

## Areas for Contribution

We welcome contributions in these areas:

### High Priority

- 🐛 **Bug fixes** - Fix issues and edge cases
- 📚 **Documentation** - Improve docs and examples
- ✅ **Tests** - Increase test coverage
- 🔍 **CRUD API** - Enhance filter operators and validation

### Medium Priority

- 🚀 **Performance** - Optimize query execution and sync
- 🎨 **Examples** - Add real-world use case examples
- 🔧 **Tooling** - Developer experience improvements

### Future Features (see ROADMAP.md)

- 🌐 **Cross-runtime** - Node.js, Bun, Browser support
- 🔄 **Bi-directional sync** - Two-way synchronization
- 🗄️ **Migrations** - Built-in migration system
- 🔍 **Query builder** - Fluent query API

---

## Getting Help

- **Issues**: Open an issue on GitHub
- **Discussions**: Use GitHub Discussions for questions
- **Examples**: Check the `/examples` folder
- **Docs**: Read the `/docs` folder

---

## License

By contributing to Ominipg, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Ominipg! 🎉


