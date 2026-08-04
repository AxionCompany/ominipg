import assert from "node:assert/strict";
import { Ominipg } from "../npm/esm/client/index.js";

class FakeClient {
  async query(sql, params = []) {
    if (/SELECT\s+42\s+AS\s+answer/i.test(sql)) {
      return { rows: [{ answer: 42, params }] };
    }
    return { rows: [] };
  }
  release() {}
  on() {
    return this;
  }
  removeListener() {
    return this;
  }
}

class FakePool {
  options;
  constructor(options) {
    this.options = options;
  }
  async connect() {
    return new FakeClient();
  }
  async end() {}
}

const db = await Ominipg.connect({
  url: "postgresql://portable.test/database",
  pgProvider: {
    loadPg: async () => ({ Pool: FakePool }),
  },
});
try {
  const result = await db.query("SELECT 42 AS answer", ["portable"]);
  assert.deepEqual(result.rows, [{ answer: 42, params: ["portable"] }]);
  await assert.rejects(
    () => db.sync(),
    /Sync is disabled in direct Postgres mode/,
  );
} finally {
  await db.close();
}

console.log("Ominipg Node-compatible workload session passed");
