import type { PgPoolClient } from "../db.ts";
import { mainDb, meta, recentlyPushed, syncPool } from "../db.ts";
import { ensureMeta } from "../schema.ts";
import { ident } from "../utils.ts";
import { EDGE_ID, LWW_COL } from "../bootstrap.ts";

// State to track if the remote supports setting a replication origin.
// We assume it does until we get a permission error.
let replicationOriginSupported = true;

async function remoteUpsert(
  client: PgPoolClient,
  table: string,
  row: Record<string, unknown>,
) {
  const m = meta.get(table)!;
  const pkList = m.pk.map(ident).join(",");
  const updSet = m.non.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(
    ", ",
  );

  await client.query(
    `
      INSERT INTO ${ident(table)}
      SELECT * FROM json_populate_record(null::${ident(table)}, $1) r
      ON CONFLICT (${pkList}) DO UPDATE
        SET ${updSet}
      WHERE ${ident(table)}.${ident(LWW_COL)} < excluded.${ident(LWW_COL)}
    `,
    [JSON.stringify(row)],
  );
}

export async function pushBatch(): Promise<number> {
  if (!syncPool) return 0;

  const client = await syncPool.connect();
  try {
    const syncResult = await mainDb.query(
      "SELECT last_push FROM _sync_state WHERE id = 1",
    );
    const lastPush =
      (syncResult.rows[0] as { last_push?: number } | undefined)?.last_push ||
      0;

    const outboxResult = await mainDb.query(
      `
            SELECT * FROM _outbox WHERE id > $1 ORDER BY id
        `,
      [lastPush],
    );

    if (outboxResult.rows.length === 0) return 0;

    // --- FIX: Set replication origin BEFORE the transaction starts ---
    if (replicationOriginSupported) {
      try {
        await client.query(`SELECT pg_replication_origin_session_setup($1)`, [
          EDGE_ID,
        ]);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes("permission denied")) {
          console.log(
            "Replication origin not supported (this is expected on some managed DBs). Falling back to basic echo prevention.",
          );
          replicationOriginSupported = false;
        } else {
          // For other errors, we still want to see a warning.
          console.warn("Could not set replication origin:", message);
        }
      }
    }

    await client.query("BEGIN");
    try {
      for (
        const row of outboxResult.rows as Array<
          {
            id: number;
            table_name: string;
            op: "I" | "U" | "D";
            pk: Record<string, unknown>;
            row_json: Record<string, unknown> | null;
          }
        >
      ) {
        await ensureMeta(row.table_name);
        const m = meta.get(row.table_name)!;

        // Track this change to prevent processing it as an echo later
        const pkValues = m.pk.map((col) =>
          String((row.pk as Record<string, unknown>)[col] || "")
        ).join("|");
        if (!recentlyPushed.has(row.table_name)) {
          recentlyPushed.set(row.table_name, new Map());
        }
        const lwwValue = row.row_json
          ? (row.row_json as Record<string, unknown>)[LWW_COL]
          : null;
        recentlyPushed.get(row.table_name)!.set(pkValues, {
          op: row.op,
          lww: lwwValue,
        });

        if (row.op === "D") {
          const whereConds = m.pk.map((p, i) => `${ident(p)} = $${i + 1}`).join(
            " AND ",
          );
          const values = m.pk.map((p) =>
            (row.pk as Record<string, unknown>)[p]
          );
          await client.query(
            `DELETE FROM ${ident(row.table_name)} WHERE ${whereConds}`,
            values,
          );
        } else {
          await remoteUpsert(
            client,
            row.table_name,
            row.row_json as Record<string, unknown>,
          );
        }
      }

      await client.query("COMMIT");

      const lastRowId = (outboxResult.rows as Array<{ id: number }>)[
        outboxResult.rows.length - 1
      ].id;
      await mainDb.query("UPDATE _sync_state SET last_push = $1 WHERE id = 1", [
        lastRowId,
      ]);
      await mainDb.query("DELETE FROM _outbox WHERE id <= $1", [lastRowId]);

      // Expire pushed keys after a timeout to prevent memory leaks if an echo is never received.
      setTimeout(() => {
        const _now = Date.now();
        for (const [_tableName, pushedMap] of recentlyPushed.entries()) {
          for (const pk of pushedMap.keys()) {
            // This is a simplified example; a real implementation would store timestamps
            // and check them here. For now, we just clear the map entry.
            pushedMap.delete(pk);
          }
        }
      }, 10000); // 10-second timeout

      return outboxResult.rows.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    // Reset replication origin if possible and supported.
    if (replicationOriginSupported) {
      try {
        await client.query("SELECT pg_replication_origin_session_reset()");
      } catch (_e) {
        // This is expected on some managed DBs, so we don't need to log.
      }
    }
    client.release();
  }
}
