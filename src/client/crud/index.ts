import type {
  CrudApi,
  CrudFilter,
  CrudQueryOptions,
  CrudSchemas,
  CrudTableApi,
  CrudTablePopulateKey,
  CrudTableRelations,
  CrudBaseRow,
  RelationConfig,
  TableMetadata,
  TableMetadataMap,
  WritableRowForTable,
} from "./types.ts";
import { buildMetadataMap } from "./schema.ts";
import { compileFilter } from "./filter.ts";

export {
  defineSchema,
} from "./defineTable.ts";

export type {
  CrudApi,
  CrudSchemas,
  CrudTableApi,
  CrudRow,
  InferKey,
  InferRow,
  JsonSchema,
  TableSchemaConfig,
  TableKeyDefinition,
  TableTimestampConfig,
  TableTimestampColumns,
} from "./types.ts";

type ExecuteFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[] }>;

type AnyRecord = Record<string, unknown>;

type Simplify<T> = { [K in keyof T]: T[K] } extends infer O ? {
  [K in keyof O]: O[K];
} : never;

function toColumnList(columns: string[]): string {
  return columns.map((col) => `"${col}"`).join(", ");
}

function normalizeSortDirection(direction: string | undefined): string {
  return direction?.toUpperCase() === "DESC" ? "DESC" : "ASC";
}

function buildOrderBy(options: CrudQueryOptions | undefined): string {
  if (!options) return "";

  const sortSpecs = options.sort;
  if (sortSpecs && sortSpecs.length > 0) {
    const parts = sortSpecs.map((spec) => {
      if (Array.isArray(spec)) {
        const [field, direction] = spec;
        return `"${field}" ${normalizeSortDirection(direction)}`;
      }
      const { field, direction } = spec as {
        field: string;
        direction?: string;
      };
      return `"${field}" ${normalizeSortDirection(direction)}`;
    });
    return parts.length > 0 ? ` ORDER BY ${parts.join(", ")}` : "";
  }

  if (!options.orderBy) return "";
  const entries = Object.entries(options.orderBy);
  if (entries.length === 0) return "";
  const parts = entries.map(([col, dir]) =>
    `"${col}" ${normalizeSortDirection(dir)}`
  );
  return ` ORDER BY ${parts.join(", ")}`;
}

function buildLimitOffset(options: CrudQueryOptions | undefined): string {
  let clause = "";
  if (options?.limit != null) {
    clause += ` LIMIT ${Number(options.limit)}`;
  }
  const offsetValue = options?.offset ?? options?.skip;
  if (offsetValue != null) {
    clause += ` OFFSET ${Number(offsetValue)}`;
  }
  return clause;
}

function ensureObject(value: unknown): asserts value is AnyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object payload.");
  }
}

function buildInsertStatement(
  metadata: TableMetadata,
  rows: AnyRecord[],
  returning = true,
): { sql: string; params: unknown[] } {
  if (rows.length === 0) {
    throw new Error("Cannot insert zero rows.");
  }
  const writableColumns = metadata.writableColumns;
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!writableColumns.has(key)) {
        throw new Error(
          `Property '${key}' is not writable for table '${metadata.tableName}'.`,
        );
      }
      if (!columns.includes(key)) {
        columns.push(key);
      }
    }
  }
  if (columns.length === 0) {
    throw new Error("Insert requires at least one column.");
  }

  const params: unknown[] = [];
  const valueRows = rows.map((row) => {
    const placeholders = columns.map((column) => {
      params.push(row[column]);
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });

  const sql = `INSERT INTO "${metadata.tableName}" (${
    toColumnList(columns)
  }) VALUES ${valueRows.join(", ")}${returning ? " RETURNING *" : ""}`;
  return { sql, params };
}

function buildUpsertStatementWithInsertDefaults(
  metadata: TableMetadata,
  filter: CrudFilter | undefined,
  data: AnyRecord,
  defaultOnlyFields: Set<string>,
): { sql: string; params: unknown[] } {
  const writableColumns = metadata.writableColumns;
  const keyValues = extractKeyValues(filter, metadata);
  const sanitizedDataEntries = Object.entries(data).filter(([key]) => {
    if (!writableColumns.has(key)) {
      throw new Error(
        `Property '${key}' is not writable for table '${metadata.tableName}'.`,
      );
    }
    return true;
  });
  const sanitizedData = Object.fromEntries(sanitizedDataEntries);
  const fullData: AnyRecord = { ...sanitizedData };
  if (keyValues) {
    metadata.keyOrder.forEach((field, index) => {
      if (!(field in fullData)) {
        fullData[field] = keyValues[index];
      }
    });
  }

  for (const field of metadata.keyOrder) {
    if (!(field in fullData)) {
      throw new Error(`Upsert requires primary key field '${field}'.`);
    }
  }

  // INSERT columns include keys + all provided columns (sanitized) + any fields present only due to defaults
  const providedCols = new Set(Object.keys(sanitizedData));
  const insertColumns = Array.from(
    new Set([
      ...metadata.keyOrder,
      ...Object.keys(sanitizedData),
      ...Array.from(defaultOnlyFields),
    ]),
  );
  const params: unknown[] = [];
  const insertPlaceholders = insertColumns.map((column) => {
    params.push(fullData[column]);
    return `$${params.length}`;
  });

  // UPDATE assignments should not include columns that were set only via defaults
  const updateAssignments = insertColumns
    .filter((column) => !metadata.keyOrder.includes(column))
    .filter((column) => providedCols.has(column))
    .map((column) => `"${column}" = EXCLUDED."${column}"`);

  const sql = `INSERT INTO "${metadata.tableName}" (${toColumnList(insertColumns)}) VALUES (${insertPlaceholders.join(", ")}) ON CONFLICT (${toColumnList(metadata.keyOrder)}) ${
    updateAssignments.length > 0
      ? `DO UPDATE SET ${updateAssignments.join(", ")}`
      : "DO NOTHING"
  } RETURNING *`;

  return { sql, params };
}

function extractKeyValues(
  filter: CrudFilter | undefined,
  metadata: TableMetadata,
): unknown[] | null {
  if (!filter) return null;
  const keyValues: unknown[] = [];
  for (const field of metadata.keyOrder) {
    if (!(field in filter)) {
      return null;
    }
    const value = (filter as AnyRecord)[field];
    if (typeof value === "object" && value !== null) {
      const maybeEq = (value as AnyRecord)["$eq"];
      if (maybeEq === undefined) return null;
      keyValues.push(maybeEq);
    } else {
      keyValues.push(value);
    }
  }
  return keyValues;
}

function _buildUpsertStatement(
  metadata: TableMetadata,
  filter: CrudFilter | undefined,
  data: AnyRecord,
): { sql: string; params: unknown[] } {
  const writableColumns = metadata.writableColumns;
  const keyValues = extractKeyValues(filter, metadata);
  const sanitizedDataEntries = Object.entries(data).filter(([key]) => {
    if (!writableColumns.has(key)) {
      throw new Error(
        `Property '${key}' is not writable for table '${metadata.tableName}'.`,
      );
    }
    return true;
  });
  const sanitizedData = Object.fromEntries(sanitizedDataEntries);
  const fullData: AnyRecord = { ...sanitizedData };
  if (keyValues) {
    metadata.keyOrder.forEach((field, index) => {
      if (!(field in fullData)) {
        fullData[field] = keyValues[index];
      }
    });
  }

  for (const field of metadata.keyOrder) {
    if (!(field in fullData)) {
      throw new Error(`Upsert requires primary key field '${field}'.`);
    }
  }

  const columns = Array.from(
    new Set([...metadata.keyOrder, ...Object.keys(sanitizedData)]),
  );
  const params: unknown[] = [];
  const insertPlaceholders = columns.map((column) => {
    params.push(fullData[column]);
    return `$${params.length}`;
  });

  const updateAssignments = columns
    .filter((column) => !metadata.keyOrder.includes(column))
    .map((column) => `"${column}" = EXCLUDED."${column}"`);

  const sql = `INSERT INTO "${metadata.tableName}" (${
    toColumnList(columns)
  }) VALUES (${insertPlaceholders.join(", ")}) ON CONFLICT (${
    toColumnList(metadata.keyOrder)
  }) ${
    updateAssignments.length > 0
      ? `DO UPDATE SET ${updateAssignments.join(", ")}`
      : "DO NOTHING"
  } RETURNING *`;

  return { sql, params };
}

async function runSelect<RowResult extends AnyRecord>(
  metadata: TableMetadata,
  execute: ExecuteFn,
  filter: CrudFilter | undefined,
  options?: CrudQueryOptions,
): Promise<RowResult[]> {
  const { text: whereClause, params } = compileFilter(metadata, filter);
  const columns = options?.select && options.select.length > 0
    ? options.select.map((col) => `"${col}"`).join(", ")
    : "*";
  const sql = `SELECT ${columns} FROM "${metadata.tableName}" ${whereClause}${
    buildOrderBy(options)
  }${buildLimitOffset(options)}`.trim();
  const result = await execute(sql, params);
  return result.rows as RowResult[];
}

async function runDelete<RowResult extends AnyRecord>(
  metadata: TableMetadata,
  execute: ExecuteFn,
  filter: CrudFilter | undefined,
  returning = true,
): Promise<{ rows: RowResult[]; count: number }> {
  const { text: whereClause, params } = compileFilter(metadata, filter);
  const sql = `DELETE FROM "${metadata.tableName}" ${whereClause}${
    returning ? " RETURNING *" : ""
  }`.trim();
  const result = await execute(sql, params);
  const rows = result.rows as RowResult[];
  return { rows, count: rows.length };
}

function applyValidation<RowType extends AnyRecord>(
  rows: RowType[],
  metadata: TableMetadata,
  validateOutput: boolean | undefined,
): RowType[] {
  if (!validateOutput) return rows;
  if (!metadata.zod) return rows;
  return rows.map((row) => metadata.zod!.parse(row) as RowType);
}

function pickValidationFlag(options?: CrudQueryOptions): boolean {
  return options?.validateOutput ?? true;
}

type TupleKey = string;

function makeTuple(values: unknown[]): TupleKey {
  return JSON.stringify(values);
}

function collectTuples(
  rows: AnyRecord[],
  fields: string[],
): { map: Map<TupleKey, unknown[]>; ordered: unknown[][] } {
  const map = new Map<TupleKey, unknown[]>();
  const ordered: unknown[][] = [];
  for (const row of rows) {
    const tuple = fields.map((field) => (row as AnyRecord)[field]);
    if (tuple.some((value) => value == null)) {
      continue;
    }
    const key = makeTuple(tuple);
    if (!map.has(key)) {
      map.set(key, tuple);
      ordered.push(tuple);
    }
  }
  return { map, ordered };
}

function buildTupleCondition(
  columns: string[],
  tuples: unknown[][],
  params: unknown[],
): string {
  if (columns.length === 0) {
    throw new Error("Tuple condition requires at least one column.");
  }
  if (tuples.length === 0) {
    return "FALSE";
  }
  if (columns.length === 1) {
    const [column] = columns;
    const placeholders = tuples.map((tuple) => {
      params.push(tuple[0]);
      return `$${params.length}`;
    });
    return `"${column}" IN (${placeholders.join(", ")})`;
  }
  const columnList = `(${columns.map((col) => `"${col}"`).join(", ")})`;
  const tupleSql = tuples.map((tuple) => {
    const placeholders = tuple.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  return `${columnList} IN (${tupleSql.join(", ")})`;
}

async function populateBelongsTo(
  rows: AnyRecord[],
  relation: RelationConfig,
  tables: TableMetadataMap,
  execute: ExecuteFn,
  validateOutput: boolean,
): Promise<void> {
  const target = tables.get(relation.targetTable);
  if (!target) return;
  const { ordered } = collectTuples(rows, relation.localFields);
  if (ordered.length === 0) {
    rows.forEach((row) => {
      (row as AnyRecord)[relation.name] = null;
    });
    return;
  }
  const params: unknown[] = [];
  const condition = buildTupleCondition(relation.targetFields, ordered, params);
  const sql = `SELECT * FROM "${relation.targetTable}" WHERE ${condition}`;
  const result = await execute(sql, params);
  const validated = applyValidation(
    result.rows as AnyRecord[],
    target,
    validateOutput,
  );
  const lookup = new Map<TupleKey, AnyRecord>();
  for (const row of validated) {
    const tuple = relation.targetFields.map((field) => row[field]);
    lookup.set(makeTuple(tuple), row);
  }
  for (const row of rows) {
    const tuple = relation.localFields.map((field) => row[field]);
    if (tuple.some((value) => value == null)) {
      (row as AnyRecord)[relation.name] = null;
      continue;
    }
    const matched = lookup.get(makeTuple(tuple));
    (row as AnyRecord)[relation.name] = matched ?? null;
  }
}

async function populateHasMany(
  rows: AnyRecord[],
  relation: RelationConfig,
  tables: TableMetadataMap,
  execute: ExecuteFn,
  validateOutput: boolean,
): Promise<void> {
  const target = tables.get(relation.targetTable);
  if (!target) return;
  const { ordered } = collectTuples(rows, relation.localFields);
  if (ordered.length === 0) {
    rows.forEach((row) => {
      (row as AnyRecord)[relation.name] = [];
    });
    return;
  }
  const params: unknown[] = [];
  const condition = buildTupleCondition(relation.targetFields, ordered, params);
  const sql = `SELECT * FROM "${relation.targetTable}" WHERE ${condition}`;
  const result = await execute(sql, params);
  const validated = applyValidation(
    result.rows as AnyRecord[],
    target,
    validateOutput,
  );
  const grouped = new Map<TupleKey, AnyRecord[]>();
  for (const row of validated) {
    const tuple = relation.targetFields.map((field) => row[field]);
    const key = makeTuple(tuple);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(row);
  }
  for (const row of rows) {
    const tuple = relation.localFields.map((field) => row[field]);
    const key = makeTuple(tuple);
    (row as AnyRecord)[relation.name] = grouped.get(key) ?? [];
  }
}

async function populateManyToMany(
  rows: AnyRecord[],
  relation: RelationConfig,
  tables: TableMetadataMap,
  execute: ExecuteFn,
  validateOutput: boolean,
): Promise<void> {
  if (
    !relation.viaTable || !relation.viaLocalFields || !relation.viaTargetFields
  ) return;
  const joinTable = relation.viaTable;
  const target = tables.get(relation.targetTable);
  if (!target) return;

  const { ordered } = collectTuples(rows, relation.localFields);
  if (ordered.length === 0) {
    rows.forEach((row) => {
      (row as AnyRecord)[relation.name] = [];
    });
    return;
  }

  const joinParams: unknown[] = [];
  const joinCondition = buildTupleCondition(
    relation.viaLocalFields,
    ordered,
    joinParams,
  );
  const joinSql = `SELECT * FROM "${joinTable}" WHERE ${joinCondition}`;
  const joinRows = await execute(joinSql, joinParams);

  const targetTuplesByParent = new Map<TupleKey, unknown[][]>();
  for (const joinRow of joinRows.rows as AnyRecord[]) {
    const parentTuple = relation.viaLocalFields.map((field) => joinRow[field]);
    const targetTuple = relation.viaTargetFields.map((field) => joinRow[field]);
    const parentKey = makeTuple(parentTuple);
    if (!targetTuplesByParent.has(parentKey)) {
      targetTuplesByParent.set(parentKey, []);
    }
    targetTuplesByParent.get(parentKey)!.push(targetTuple);
  }

  const uniqueTargetTuples: unknown[][] = [];
  const seenTargets = new Map<TupleKey, unknown[]>();
  for (const tuples of targetTuplesByParent.values()) {
    for (const tuple of tuples) {
      const key = makeTuple(tuple);
      if (!seenTargets.has(key)) {
        seenTargets.set(key, tuple);
        uniqueTargetTuples.push(tuple);
      }
    }
  }

  if (uniqueTargetTuples.length === 0) {
    rows.forEach((row) => {
      (row as AnyRecord)[relation.name] = [];
    });
    return;
  }

  const targetParams: unknown[] = [];
  const targetCondition = buildTupleCondition(
    relation.targetFields,
    uniqueTargetTuples,
    targetParams,
  );
  const targetSql =
    `SELECT * FROM "${relation.targetTable}" WHERE ${targetCondition}`;
  const targetRows = await execute(targetSql, targetParams);
  const validatedTargets = applyValidation(
    targetRows.rows as AnyRecord[],
    target,
    validateOutput,
  );
  const targetLookup = new Map<TupleKey, AnyRecord>();
  for (const targetRow of validatedTargets) {
    const tuple = relation.targetFields.map((field) => targetRow[field]);
    targetLookup.set(makeTuple(tuple), targetRow);
  }

  for (const row of rows) {
    const parentTuple = relation.localFields.map((field) => row[field]);
    const parentKey = makeTuple(parentTuple);
    const tuples = targetTuplesByParent.get(parentKey) ?? [];
    const populated: AnyRecord[] = [];
    for (const tuple of tuples) {
      const key = makeTuple(tuple);
      const targetRow = targetLookup.get(key);
      if (targetRow) {
        populated.push(targetRow);
      }
    }
    (row as AnyRecord)[relation.name] = populated;
  }
}

async function populateRows<RowType extends AnyRecord>(
  rows: RowType[],
  metadata: TableMetadata,
  tables: TableMetadataMap,
  execute: ExecuteFn,
  populate: readonly string[] | undefined,
  validateOutput: boolean,
): Promise<RowType[]> {
  if (!populate || populate.length === 0 || rows.length === 0) {
    return rows;
  }

  const workingRows = rows as unknown as AnyRecord[];

  for (const relationName of populate) {
    const relation = metadata.relations.find((rel) =>
      rel.name === relationName
    );
    if (!relation) {
      throw new Error(
        `Relation '${relationName}' is not defined for table '${metadata.tableName}'.`,
      );
    }
    switch (relation.type) {
      case "belongsTo":
        await populateBelongsTo(
          workingRows,
          relation,
          tables,
          execute,
          validateOutput,
        );
        break;
      case "hasMany":
        await populateHasMany(
          workingRows,
          relation,
          tables,
          execute,
          validateOutput,
        );
        break;
      case "manyToMany":
        await populateManyToMany(
          workingRows,
          relation,
          tables,
          execute,
          validateOutput,
        );
        break;
    }
  }

  return rows;
}

function buildTableApi<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
>(
  _tableName: TableName,
  metadata: TableMetadata,
  execute: ExecuteFn,
  tables: TableMetadataMap,
): CrudTableApi<
  CrudBaseRow<Schemas, TableName>,
  CrudTableRelations<Schemas, TableName>,
  WritableRowForTable<Schemas, TableName>,
  CrudTablePopulateKey<Schemas, TableName>
> {
  type Row = CrudBaseRow<Schemas, TableName>;
  type Relations = CrudTableRelations<Schemas, TableName>;
  type Writable = WritableRowForTable<Schemas, TableName>;
  type PopulateKey = CrudTablePopulateKey<Schemas, TableName>;
  type ResultRow = Simplify<Row & Partial<Relations>>;

  const writableColumnSet = metadata.writableColumns;
  const timestampConfig = metadata.timestamps;

  function applyInsertDefaults<RecordType extends AnyRecord>(
    record: RecordType,
  ): { value: RecordType; defaultOnlyFields: Set<string> } {
    const clone = { ...record } as AnyRecord;
    const defaultOnly = new Set<string>();
    const staticDefaults = metadata.staticDefaults ?? {};
    for (const [key, val] of Object.entries(staticDefaults)) {
      if (clone[key] === undefined) {
        clone[key] = val;
        defaultOnly.add(key);
      }
    }
    const dynamicDefaults = metadata.dynamicDefaults ?? {};
    for (const [key, fn] of Object.entries(dynamicDefaults)) {
      if (clone[key] === undefined) {
        try {
          clone[key] = fn();
          defaultOnly.add(key);
        } catch (_e) {
          // Ignore default function errors, leave undefined
        }
      }
    }
    return { value: clone as RecordType, defaultOnlyFields: defaultOnly };
  }

  function applyTimestamps<RecordType extends AnyRecord>(
    record: RecordType,
    mode: "create" | "update" | "upsert",
  ): RecordType {
    if (!timestampConfig) return record;
    const now = new Date().toISOString();
    const clone = { ...record } as RecordType;
    const mutableClone = clone as AnyRecord;
    if (mode === "create" || mode === "upsert") {
      if (mutableClone[timestampConfig.createdAt] == null) {
        mutableClone[timestampConfig.createdAt] = now;
      }
    }
    mutableClone[timestampConfig.updatedAt] = now;
    return clone;
  }

  async function find(
    filter?: CrudFilter | null,
    options?: CrudQueryOptions<PopulateKey>,
  ): Promise<ResultRow[]> {
    const rows = await runSelect<ResultRow>(
      metadata,
      execute,
      filter ?? undefined,
      options,
    );
    const validated = applyValidation(
      rows,
      metadata,
      pickValidationFlag(options),
    );
    const populated = await populateRows(
      validated,
      metadata,
      tables,
      execute,
      options?.populate,
      pickValidationFlag(options),
    );
    return populated;
  }

  async function findOne(
    filter?: CrudFilter | null,
    options?: CrudQueryOptions<PopulateKey>,
  ): Promise<ResultRow | null> {
    const rows = await runSelect<ResultRow>(
      metadata,
      execute,
      filter ?? undefined,
      { ...options, limit: 1 },
    );
    const validated = applyValidation(
      rows,
      metadata,
      pickValidationFlag(options),
    );
    const populated = await populateRows(
      validated,
      metadata,
      tables,
      execute,
      options?.populate,
      pickValidationFlag(options),
    );
    const first = populated[0];
    return first ?? null;
  }

  async function create(
    data: Writable,
    options?: { validateOutput?: boolean },
  ): Promise<ResultRow> {
    ensureObject(data);
    const stamped = applyTimestamps({ ...data }, "create") as Writable;
    const { value: withDefaults } = applyInsertDefaults(stamped as AnyRecord);
    const { sql, params } = buildInsertStatement(metadata, [withDefaults]);
    const result = await execute(sql, params);
    const rows = applyValidation(
      result.rows as ResultRow[],
      metadata,
      options?.validateOutput ?? true,
    );
    return rows[0];
  }

  async function createMany(
    list: Writable[],
    options?: { validateOutput?: boolean },
  ): Promise<ResultRow[]> {
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error("createMany expects a non-empty array of objects.");
    }
    const prepared: Writable[] = [];
    for (const item of list) {
      ensureObject(item);
      const stamped = applyTimestamps({ ...item }, "create") as Writable;
      const { value: withDefaults } = applyInsertDefaults(stamped as AnyRecord);
      prepared.push(withDefaults as Writable);
    }
    const { sql, params } = buildInsertStatement(metadata, prepared);
    const result = await execute(sql, params);
    const rows = applyValidation(
      result.rows as ResultRow[],
      metadata,
      options?.validateOutput ?? true,
    );
    return rows;
  }

  async function update(
    filter: CrudFilter | undefined,
    data: Partial<Writable>,
    options?: { upsert?: boolean; validateOutput?: boolean },
  ): Promise<ResultRow | null> {
    ensureObject(data);
    if (options?.upsert) {
      const stamped = applyTimestamps({ ...data }, "upsert") as AnyRecord;
      const { value: withDefaults, defaultOnlyFields } = applyInsertDefaults(
        stamped,
      );
      const { sql, params } = buildUpsertStatementWithInsertDefaults(
        metadata,
        filter,
        withDefaults,
        defaultOnlyFields,
      );
      const result = await execute(sql, params);
      const rows = applyValidation(
        result.rows as ResultRow[],
        metadata,
        options?.validateOutput ?? true,
      );
      const first = rows[0];
      return first ?? null;
    }
    const stamped = applyTimestamps({ ...data }, "update");
    const setColumns = Object.keys(stamped as AnyRecord);
    if (setColumns.length === 0) {
      throw new Error("update requires at least one field to modify.");
    }
    for (const column of setColumns) {
      if (!writableColumnSet.has(column)) {
        throw new Error(
          `Property '${column}' is not writable for table '${metadata.tableName}'.`,
        );
      }
    }
    const recordData = stamped as AnyRecord;
    const params: unknown[] = [];
    const assignments = setColumns.map((column) => {
      params.push(recordData[column]);
      return `"${column}" = $${params.length}`;
    });
    const { text: whereClause, params: whereParams } = compileFilter(
      metadata,
      filter,
      params.length,
    );
    const sql = `UPDATE "${metadata.tableName}" SET ${
      assignments.join(", ")
    } ${whereClause} RETURNING *`;
    const result = await execute(sql, [...params, ...whereParams]);
    const rows = applyValidation(
      result.rows as ResultRow[],
      metadata,
      options?.validateOutput ?? true,
    );
    const first = rows[0];
    return first ?? null;
  }

  async function updateMany(
    filter: CrudFilter | undefined,
    data: Partial<Writable>,
    options?: { upsert?: boolean; validateOutput?: boolean },
  ): Promise<{ rows: ResultRow[]; count: number }> {
    ensureObject(data);
    if (options?.upsert) {
      throw new Error("updateMany does not support upsert.");
    }
    const stamped = applyTimestamps({ ...data }, "update");
    const setColumns = Object.keys(stamped as AnyRecord);
    if (setColumns.length === 0) {
      throw new Error("updateMany requires at least one field to modify.");
    }
    for (const column of setColumns) {
      if (!writableColumnSet.has(column)) {
        throw new Error(
          `Property '${column}' is not writable for table '${metadata.tableName}'.`,
        );
      }
    }
    const recordData = stamped as AnyRecord;
    const params: unknown[] = [];
    const assignments = setColumns.map((column) => {
      params.push(recordData[column]);
      return `"${column}" = $${params.length}`;
    });
    const { text: whereClause, params: whereParams } = compileFilter(
      metadata,
      filter,
      params.length,
    );
    const sql = `UPDATE "${metadata.tableName}" SET ${
      assignments.join(", ")
    } ${whereClause} RETURNING *`;
    const result = await execute(sql, [...params, ...whereParams]);
    const rows = applyValidation(
      result.rows as ResultRow[],
      metadata,
      options?.validateOutput ?? true,
    );
    return {
      rows,
      count: rows.length,
    };
  }

  async function remove(
    filter: CrudFilter | undefined,
    options?: { validateOutput?: boolean },
  ): Promise<ResultRow | null> {
    const { rows } = await runDelete<ResultRow>(
      metadata,
      execute,
      filter,
      true,
    );
    const validated = applyValidation(
      rows,
      metadata,
      options?.validateOutput ?? true,
    );
    const first = validated[0];
    return first ?? null;
  }

  async function removeMany(
    filter: CrudFilter | undefined,
  ): Promise<{ count: number }> {
    const { count } = await runDelete<AnyRecord>(
      metadata,
      execute,
      filter,
      false,
    );
    return { count };
  }

  const apiRecord: Record<string, unknown> = {
    find,
    findOne,
    create,
    createMany,
    update,
    updateMany,
    delete: remove,
    deleteMany: removeMany,
  };

  return apiRecord as CrudTableApi<Row, Relations, Writable, PopulateKey>;
}

export function createCrudApi<Schemas extends CrudSchemas>(
  schemas: Schemas,
  execute: ExecuteFn,
): CrudApi<Schemas> {
  const metadataMap = buildMetadataMap(schemas);
  const result = {} as CrudApi<Schemas>;
  for (const tableName of Object.keys(schemas) as Array<keyof Schemas>) {
    const metadata = metadataMap.get(tableName as string);
    if (!metadata) continue;
    result[tableName] = buildTableApi<Schemas, typeof tableName>(
      tableName,
      metadata,
      execute,
      metadataMap,
    );
  }
  return result;
}
