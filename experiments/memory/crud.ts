import { createCrudApi, defineSchema } from "../../src/client/crud/index.ts";
import { delay, snapshotMemory } from "./_utils.ts";

console.log("CRUD API memory\n===============");

await snapshotMemory("startup");

const schemas = defineSchema({
  items: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        created_at: { type: "string" },
        updated_at: { type: "string" },
      },
      required: ["id", "name"],
    },
    keys: [{ property: "id" }],
    timestamps: true,
  },
});

createCrudApi(schemas, async () => ({ rows: [] }));

await delay(200);
await snapshotMemory("after createCrudApi");
