import { defineSchema, Ominipg, type CrudRow } from "./src/client/index.ts";

const schemas = defineSchema({
  posts: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
      },
      required: ["id", "title"],
    },
    keys: [{ property: "id" }],
  },
});

async function main() {
  const db = await Ominipg.connect({ url: ":memory:", schemas });
  const { crud } = db;
  const post = await crud.posts.findOne({ id: "1" });
  if (post) {
    post satisfies CrudRow<typeof schemas, "posts">;
  }
  await db.close();
}

main();
