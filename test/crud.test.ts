import { defineSchema, Ominipg } from "../src/client/index.ts";
import {
  assertEquals,
  assertExists,
  assertNotEquals,
} from "jsr:@std/assert@1.0.13";

const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
      },
      required: ["id", "name", "email"],
    },
    keys: [{ property: "id" }],
    defaults: {
      id: () => crypto.randomUUID(),
    },
  },
  posts: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        authorId: { $ref: "#/$defs/users/properties/id" },
        title: { type: "string" },
        body: { type: "string" },
        published: { type: "boolean" },
        excerpt: { type: ["string", "null"] },
        wordCount: { type: ["integer", "null"] },
        created_at: { type: "string" },
        updated_at: { type: "string" },
        metadata: {
          type: "object",
          properties: {
            category: {
              type: "object",
              properties: {
                primary: { type: "string" },
                secondary: { type: "string" },
              },
              required: ["primary", "secondary"],
            },
            rating: { type: ["number", "null"] },
          },
          required: ["category"],
        },
        author: {
          readOnly: true,
          anyOf: [{ $ref: "#/$defs/users" }, { type: "null" }],
        },
        tags: {
          type: "array",
          readOnly: true,
          items: { $ref: "#/$defs/tags" },
        },
      },
      required: ["id", "authorId", "title", "body"],
    },
    keys: [{ property: "id" }],
    timestamps: true,
  },
  tags: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        label: { type: "string" },
      },
      required: ["id", "label"],
    },
    keys: [{ property: "id" }],
  },
  posts_tags: {
    schema: {
      type: "object",
      properties: {
        postId: { $ref: "#/$defs/posts/properties/id" },
        tagId: { $ref: "#/$defs/tags/properties/id" },
      },
      required: ["postId", "tagId"],
    },
    keys: [{ property: "postId" }, { property: "tagId" }],
  },
});

const schemaSQL = [
  `CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS posts(
        id TEXT PRIMARY KEY,
        "authorId" TEXT NOT NULL REFERENCES users(id),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        published BOOLEAN DEFAULT FALSE,
        excerpt TEXT,
        "wordCount" INTEGER,
        created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
        metadata JSONB
    )`,
  `CREATE TABLE IF NOT EXISTS tags(
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS posts_tags(
        "postId" TEXT NOT NULL REFERENCES posts(id),
        "tagId" TEXT NOT NULL REFERENCES tags(id),
        PRIMARY KEY("postId", "tagId")
    )`,
];

const uuid = () => crypto.randomUUID();

Deno.test("CRUD helpers - basic operations with populate", async () => {
  const db = await Ominipg.connect({
    url: ":memory:",
    schemaSQL,
    schemas,
    pgliteConfig: {
      initialMemory: 128 * 1024 * 1024,
    },
  });

  const { crud } = db;

  assertExists(crud, "crud API should be available when schemas are provided");

  const postId = uuid();
  const tagA = uuid();
  const tagB = uuid();

  const insertUserWithoutId: typeof schemas.users.$inferInsert = {
    name: "Ada Lovelace",
    email: "ada@example.com",
  };
  void insertUserWithoutId;

  const user = await crud.users.create({
    name: "Ada Lovelace",
    email: "ada@example.com",
  });
  const userId = user.id;

  await crud.posts.create({
    id: postId,
    authorId: userId,
    title: "Hello",
    body: "World",
    published: true,
    excerpt: "Greeting",
    wordCount: 200,
    metadata: {
      category: { primary: "news", secondary: "updates" },
      rating: 4.5,
    },
  });
  await crud.tags.createMany([
    { id: tagA, label: "math" },
    { id: tagB, label: "history" },
  ]);
  await crud.posts_tags.createMany([
    { postId, tagId: tagA },
    { postId, tagId: tagB },
  ]);

  const extraPostA = uuid();
  const extraPostB = uuid();
  const extraPostC = uuid();
  const typeCheckInsert: typeof schemas.posts.$inferInsert = {
    id: uuid(),
    authorId: userId,
    title: "TypeCheck",
    body: "Sample body",
    published: false,
    metadata: {
      category: { primary: "type", secondary: "check" },
    },
  };

  type NewPost = typeof schemas.posts.$inferInsert;
  type Post = typeof schemas.posts.$inferSelect;

  void typeCheckInsert;
  await crud.posts.createMany([
    {
      id: extraPostA,
      authorId: userId,
      title: "Aardvark",
      body: "First extra post",
      published: false,
      excerpt: "Beginnings",
      wordCount: 120,
      metadata: {
        category: { primary: "guides", secondary: "tutorial" },
        rating: 3.2,
      },
    },
    {
      id: extraPostB,
      authorId: userId,
      title: "Zeppelin",
      body: "Second extra post",
      published: false,
      excerpt: null,
      wordCount: 450,
      metadata: {
        category: { primary: "opinion", secondary: "tech" },
        rating: null,
      },
    },
    {
      id: extraPostC,
      authorId: userId,
      title: "Midnight",
      body: "Contains the keyword",
      published: false,
      excerpt: null,
      wordCount: 180,
      metadata: {
        category: { primary: "news", secondary: "history" },
        rating: 4.8,
      },
    },
  ]);

  await crud.posts_tags.create({ postId: extraPostC, tagId: tagB });

  const post = await crud.posts.findOne({ id: postId }, {
    populate: ["author", "tags"],
  });

  assertExists(post);
  assertExists(post.author);
  assertEquals(post.author.email, "ada@example.com");
  assertEquals(post.tags?.length ?? 0, 2);
  assertExists(post.created_at);
  assertExists(post.updated_at);
  const originalUpdatedAt = post.updated_at;

  const sortedPosts = await crud.posts.find({}, {
    sort: [{ field: "title", direction: "asc" }],
  });

  
  sortedPosts.forEach((p) => {
    assertEquals(p.title, "Aardvark");
    assertEquals(p.title, "Hello");
    assertEquals(p.title, "Midnight");
    assertEquals(p.title, "Zeppelin");
  });

  const pagedPosts = await crud.posts.find({}, {
    sort: [{ field: "title", direction: "asc" }, {
      field: "id",
      direction: "asc",
    }],
    limit: 1,
    skip: 1,
  })
  assertEquals(pagedPosts.length, 1);
  assertEquals(pagedPosts[0].title, "Hello");

  const newsPosts = await crud.posts.find({
    "metadata.category.primary": { $eq: "news" },
  }, {
    sort: [{ field: "title", direction: "asc" }],
  })
  newsPosts.forEach((p) => {
    assertEquals(p.title, "Hello");
    assertEquals(p.title, "Midnight");
  });

  const tagHistoryPosts = await crud.posts.find({
    $and: [
      { published: { $eq: false } },
      {
        $or: [
          { title: { $ilike: "%mid%" } },
          { body: { $like: "%keyword%" } },
        ],
      },
      {
        id: {
          $in: ((await crud.posts_tags.find({
            tagId: tagB,
          }, {
            select: ["postId"],
            validateOutput: false,
          })) as { postId: string }[]).map((row) => row.postId),
        },
      },
      { excerpt: { $exists: false } },
    ],
  });
  assertEquals(tagHistoryPosts.length, 1);
  assertEquals((tagHistoryPosts[0]).title, "Midnight");

  const highRatedPosts = await crud.posts.find({
    "metadata.rating": { $gte: 4.7 },
  });
  highRatedPosts.forEach((p) => {
    assertEquals(p.title, "Midnight");
  });

  const complexFilter = await crud.posts.find({
    $or: [
      {
        $and: [
          { published: { $eq: false } },
          { title: { $gt: "B" } },
          { body: { $ne: "World" } },
          { body: { $exists: true } },
          { wordCount: { $lte: 200 } },
        ],
      },
      {
        $and: [
          { published: true },
          { title: { $eq: "Hello" } },
          { wordCount: { $gte: 200 } },
        ],
      },
    ],
  }, {
    sort: [{ field: "title", direction: "asc" }],
  });

  complexFilter.forEach((p) => {
    assertEquals(p.title, "Hello");
    assertEquals(p.title, "Midnight");
  }); 

  const nullRatingPosts = await crud.posts.find({
    "metadata.rating": { $eq: null },
  }, {
    sort: [{ field: "title", direction: "asc" }],
  });

  nullRatingPosts.forEach((p) => {
    assertEquals(p.title, "Zeppelin");
  });

  const wordCountRange = await crud.posts.find({
    wordCount: { $gte: 150, $lt: 300 },
  }, {
    orderBy: { title: "asc" },
  });
  wordCountRange.forEach((p) => {
    assertEquals(p.title, "Hello");
    assertEquals(p.title, "Midnight");
  });
  wordCountRange.forEach((p) => {
    assertEquals(p.title, "Hello");
    assertEquals(p.title, "Midnight");
  });

  const secondaryMatch = await crud.posts.find({
    "metadata.category.secondary": { $in: ["updates", "history"] },
  }, {
    sort: [{ field: "title", direction: "asc" }],
  });
  secondaryMatch.forEach((p) => {
    assertEquals(p.title, "Hello");
    assertEquals(p.title, "Midnight");
  });

  const userWithPosts = await crud.users.findOne({ id: userId });
  assertExists(userWithPosts);

  const updated = await crud.posts.update({ id: postId }, {
    title: "Updated",
  });
  assertExists(updated);
  assertEquals(updated.title, "Updated");
  assertExists(updated.updated_at);
  if (originalUpdatedAt) {
    assertNotEquals(updated.updated_at, originalUpdatedAt);
  }

  const upserted = await crud.posts.update(
    { id: "missing-post" },
    {
      id: "missing-post",
      authorId: userId,
      title: "Upserted",
      body: "Created via upsert",
      metadata: {
        category: { primary: "misc", secondary: "upsert" },
        rating: null,
      },
    },
    { upsert: true },
  );
  assertExists(upserted);
  assertEquals(upserted.id, "missing-post");
  assertExists(upserted.created_at);
  assertExists(upserted.updated_at);

  const deleted = await crud.posts.delete({ id: "missing-post" });
  assertExists(deleted);

  await db.close();
});
