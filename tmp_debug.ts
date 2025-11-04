import { defineSchema } from "./src/client/crud/index.ts";

const schemas = defineSchema({
  posts: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        excerpt: { type: ["string", "null"] },
      },
      required: ["id"],
    },
    keys: [{ property: "id" }],
  },
});

type Insert = typeof schemas.posts.$inferInsert;

const value: Insert = {
  id: "1",
  excerpt: "hello",
};
