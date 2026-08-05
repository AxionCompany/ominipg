import {
  type EngineState,
  loadLogicalReplicationModule,
  requireMainDb,
} from "../db.ts";
import { createTableFromRemote, ensureMeta } from "../schema.ts";
import { ident } from "../utils.ts";
import type { OminipgEngineConfig } from "../../shared/types.ts";

type WalLog = Readonly<{
  origin?: unknown;
  relation: Readonly<{ name: string }>;
  tag: string;
  old?: Record<string, unknown> | null;
  new?: Record<string, unknown> | null;
}>;

function isWalLog(value: unknown): value is WalLog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.tag === "string" && !!record.relation &&
    typeof record.relation === "object" &&
    typeof (record.relation as Record<string, unknown>).name === "string";
}

function isLessThanOrEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") {
    return left <= right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left <= right;
  }
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() <= right.getTime();
  }
  return String(left) <= String(right);
}

async function localUpsert(
  state: EngineState,
  table: string,
  row: Record<string, unknown>,
) {
  const mainDb = requireMainDb(state);
  const m = state.meta.get(table)!;

  // Use a transaction to ensure the session variable is set only for this operation
  await mainDb.exec("BEGIN");
  try {
    await mainDb.exec(`SET LOCAL app.sync.is_applying_remote_change = 'true'`);

    const pkList = m.pk.map(ident).join(",");
    const updSet = m.non.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(
      ", ",
    );

    await mainDb.query(
      `
          INSERT INTO ${ident(table)}
          SELECT * FROM json_populate_record(null::${ident(table)}, $1) s
          ON CONFLICT (${pkList}) DO UPDATE
            SET ${updSet}
          WHERE ${ident(table)}.${ident(state.lwwColumn)} < EXCLUDED.${
        ident(state.lwwColumn)
      }
        `,
      [JSON.stringify(row)],
    );

    await mainDb.exec("COMMIT");
  } catch (err) {
    await mainDb.exec("ROLLBACK");
    throw err;
  }
}

async function localDelete(
  state: EngineState,
  table: string,
  pk: Record<string, unknown>,
) {
  const mainDb = requireMainDb(state);
  const m = state.meta.get(table)!;

  // Use a transaction to ensure the session variable is set only for this operation
  await mainDb.exec("BEGIN");
  try {
    await mainDb.exec(`SET LOCAL app.sync.is_applying_remote_change = 'true'`);

    const whereConds = m.pk.map((p, i) => `${ident(p)} = $${i + 1}`).join(
      " AND ",
    );
    const values = m.pk.map((p) => pk[p]);

    await mainDb.query(
      `DELETE FROM ${ident(table)} WHERE ${whereConds}`,
      values,
    );

    await mainDb.exec("COMMIT");
  } catch (err) {
    await mainDb.exec("ROLLBACK");
    throw err;
  }
}

async function handleWalMessage(state: EngineState, log: WalLog) {
  if (log.origin === state.edgeId) return; // Skip echo from our own origin

  const tableName = log.relation.name;
  const isDelete = log.tag === "delete";
  const rowData = isDelete ? log.old : log.new;

  // --- FIX: Guard against null rowData ---
  if (!rowData) {
    console.warn(
      `Skipping WAL message for table '${tableName}' due to missing row data.`,
    );
    return;
  }

  await ensureMeta(state, tableName);
  const m = state.meta.get(tableName)!;

  const pkValues = m.pk.map((col) => String(rowData[col] || "")).join("|");
  const pushedInfo = state.recentlyPushed.get(tableName)?.get(pkValues);

  if (pushedInfo) {
    const incomingLww = rowData[state.lwwColumn];
    // It's an echo if the operation is the same AND the LWW value is the same or older.
    // For deletes, the LWW value is not applicable.
    if (
      pushedInfo.op === log.tag.charAt(0).toUpperCase() &&
      (pushedInfo.op === "D" ||
        (pushedInfo.lww && isLessThanOrEqual(incomingLww, pushedInfo.lww)))
    ) {
      state.recentlyPushed.get(tableName)!.delete(pkValues); // Consume the echo
      if (state.recentlyPushed.get(tableName)!.size === 0) {
        state.recentlyPushed.delete(tableName);
      }
      return;
    }
  }

  try {
    if (isDelete) {
      await localDelete(state, tableName, rowData);
    } else {
      await localUpsert(state, tableName, rowData);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("does not exist")) {
      if (state.syncPool) {
        const client = await state.syncPool.connect();
        try {
          await createTableFromRemote(state, client, tableName);
        } finally {
          client.release();
        }
      } else {
        console.error(
          `Cannot create table '${tableName}': syncPool is not configured.`,
        );
        return;
      }

      // Retry the operation after creating the table
      if (isDelete) {
        await localDelete(state, tableName, rowData);
      } else {
        await localUpsert(state, tableName, rowData);
      }
    } else {
      throw error;
    }
  }
}

export async function startPuller(
  state: EngineState,
  cfg: OminipgEngineConfig,
) {
  const syncPool = state.syncPool;
  if (!syncPool) return;

  const slot = `edge_${state.edgeId.replace(/-/g, "")}`;
  const pubName = `edge_pub_${state.edgeId.replace(/-/g, "")}`;

  const client = await syncPool.connect();
  try {
    // 1. Ensure publication exists
    const pubExists = await client.query(
      `SELECT 1 FROM pg_publication WHERE pubname = $1`,
      [pubName],
    );
    if (pubExists.rows.length === 0) {
      await client.query(`CREATE PUBLICATION ${ident(pubName)} FOR ALL TABLES`);
    }

    // 2. Ensure this edge's replication slot exists. Retired slot cleanup is an
    // operator concern: deleting every inactive `edge_%` slot here can destroy
    // another embedded session's durable replication position.
    const slotExistsResult = await client.query(
      `SELECT 1 FROM pg_replication_slots WHERE slot_name = $1`,
      [slot],
    );
    if (slotExistsResult.rows.length === 0) {
      await client.query(
        `SELECT pg_create_logical_replication_slot($1, 'pgoutput')`,
        [slot],
      );
    }
  } catch (err) {
    console.error("Failed to ensure publication/slot:", err);
    // Don't continue if we can't set up the slot
    throw err;
  } finally {
    client.release();
  }

  const connectionString = cfg.syncUrl || syncPool?.options?.connectionString ||
    "";
  const { LogicalReplicationService, PgoutputPlugin } =
    await loadLogicalReplicationModule(state);
  state.replicationService = new LogicalReplicationService({
    connectionString,
  });

  // --- FIX: Run subscription as a background process ---

  // Wrap the subscription in a promise that resolves when replication starts
  const started = new Promise<void>((resolve, reject) => {
    state.replicationService!.on("start", () => {
      resolve();
    });
    state.replicationService!.on("error", (err) => {
      console.error("Replication error, will not start:", err);
      reject(err);
    });
  });

  state.replicationService.on("data", (...args: unknown[]) => {
    const log = args[1];
    if (!isWalLog(log)) return;
    if (log.tag === "insert" || log.tag === "update" || log.tag === "delete") {
      handleWalMessage(state, log).catch((err) =>
        console.error("WAL Error:", err)
      );
    }
  });

  const plugin = new PgoutputPlugin({
    protoVersion: 1,
    publicationNames: [pubName],
  });

  // Start the subscription but don't await its completion here
  state.replicationService.subscribe(plugin, slot).catch((err) => {
    console.error("Replication subscription failed:", err);
  });

  // Wait only for the 'start' event before returning
  await started;
}

export async function stopPuller(state: EngineState) {
  await state.replicationService?.stop();
  state.replicationService = null;
}
