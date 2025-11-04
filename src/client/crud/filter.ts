import type { CrudFilter, TableMetadata } from "./types.ts";

interface CompiledFilter {
  text: string;
  params: unknown[];
}

type Operator =
  | "$eq"
  | "$ne"
  | "$gt"
  | "$gte"
  | "$lt"
  | "$lte"
  | "$in"
  | "$nin"
  | "$like"
  | "$ilike"
  | "$exists";

const COMPARISON_OPERATORS: Record<Operator, string> = {
  $eq: "=",
  $ne: "<>",
  $gt: ">",
  $gte: ">=",
  $lt: "<",
  $lte: "<=",
  $in: "IN",
  $nin: "NOT IN",
  $like: "LIKE",
  $ilike: "ILIKE",
  $exists: "EXISTS",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseFieldPath(field: string): { column: string; path: string[] } {
  if (!field.includes(".")) {
    return { column: field, path: [] };
  }
  const segments: string[] = [];
  let current = "";
  let escaping = false;
  for (const char of field) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === ".") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  const [column, ...path] = segments;
  return { column, path };
}

function escapeJsonPathSegment(segment: string): string {
  return segment.replace(/'/g, "''");
}

function buildJsonAccessor(
  column: string,
  path: string[],
  asText: boolean,
): string {
  if (path.length === 0) {
    return `"${column}"`;
  }
  const args = path.map((segment) => `'${escapeJsonPathSegment(segment)}'`).join(", ");
  const extractor = asText ? "jsonb_extract_path_text" : "jsonb_extract_path";
  return `${extractor}("${column}"::jsonb, ${args})`;
}

function buildColumnExpressionForOperator(
  column: string,
  path: string[],
  operator: Operator,
  value: unknown,
): string {
  if (path.length === 0) {
    return `"${column}"`;
  }
  if (operator === "$exists") {
    return buildJsonAccessor(column, path, false);
  }
  if (value === null) {
    return buildJsonAccessor(column, path, true);
  }
  if (typeof value === "number") {
    return `(${buildJsonAccessor(column, path, true)})::double precision`;
  }
  if (typeof value === "boolean") {
    return `(${buildJsonAccessor(column, path, true)})::boolean`;
  }
  return buildJsonAccessor(column, path, true);
}

function ensureColumn(metadata: TableMetadata, field: string): void {
  if (!metadata.properties[field]) {
    throw new Error(
      `Unknown column '${field}' for table '${metadata.tableName}'.`,
    );
  }
}

function compileExists(
  column: string,
  flag: unknown,
  _params: unknown[],
): string {
  if (typeof flag !== "boolean") {
    throw new Error(`$exists expects a boolean value.`);
  }
  return flag ? `${column} IS NOT NULL` : `${column} IS NULL`;
}

function compileComparison(
  column: string,
  operator: Operator,
  value: unknown,
  params: unknown[],
  offset: number,
): string {
  if (operator === "$exists") {
    return compileExists(column, value, params);
  }

  if (value === null) {
    if (operator === "$eq") {
      return `${column} IS NULL`;
    }
    if (operator === "$ne") {
      return `${column} IS NOT NULL`;
    }
  }

  if (operator === "$in" || operator === "$nin") {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`${operator} expects a non-empty array.`);
    }
    const placeholders = value.map((item) => {
      params.push(item);
      return `$${offset + params.length}`;
    });
    return `${column} ${COMPARISON_OPERATORS[operator]} (${
      placeholders.join(", ")
    })`;
  }

  params.push(value);
  return `${column} ${COMPARISON_OPERATORS[operator]} $${
    offset + params.length
  }`;
}

function compileFieldCondition(
  metadata: TableMetadata,
  field: string,
  value: unknown,
  params: unknown[],
  offset: number,
): string {
  const { column, path } = parseFieldPath(field);
  ensureColumn(metadata, column);

  if (!isPlainObject(value)) {
    const columnExpr = buildColumnExpressionForOperator(column, path, "$eq", value);
    return compileComparison(columnExpr, "$eq", value, params, offset);
  }

  const clauses: string[] = [];
  for (const [opKey, opValue] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(
      COMPARISON_OPERATORS,
      opKey as Operator,
    )) {
      throw new Error(
        `Unsupported operator '${opKey}' in filter for column '${field}'.`,
      );
    }
    const operator = opKey as Operator;
    const columnExpr = buildColumnExpressionForOperator(column, path, operator, opValue);
    const clause = compileComparison(
      columnExpr,
      operator,
      opValue,
      params,
      offset,
    );
    clauses.push(clause);
  }

  if (clauses.length === 1) {
    return clauses[0];
  }
  return `(${clauses.join(" AND ")})`;
}

function compileLogical(
  metadata: TableMetadata,
  operator: "$and" | "$or" | "$not",
  value: unknown,
  params: unknown[],
  offset: number,
): string {
  if (operator === "$not") {
    if (!isPlainObject(value)) {
      throw new Error(`$not expects an object.`);
    }
    const inner = compileObject(metadata, value, params, offset);
    return `(NOT (${inner}))`;
  }

  const logicalValues = Array.isArray(value) ? value : [value];
  if (logicalValues.length === 0) {
    throw new Error(`${operator} expects at least one condition.`);
  }

  const compiled = logicalValues.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new Error(`${operator} expects objects inside the array.`);
    }
    return `(${compileObject(metadata, entry, params, offset)})`;
  });

  const joiner = operator === "$and" ? " AND " : " OR ";
  return compiled.join(joiner);
}

function compileObject(
  metadata: TableMetadata,
  filter: Record<string, unknown>,
  params: unknown[],
  offset: number,
): string {
  const clauses: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" || key === "$or" || key === "$not") {
      clauses.push(compileLogical(metadata, key, value, params, offset));
    } else {
      clauses.push(compileFieldCondition(metadata, key, value, params, offset));
    }
  }
  return clauses.length > 0 ? clauses.join(" AND ") : "TRUE";
}

export function compileFilter(
  metadata: TableMetadata,
  filter?: CrudFilter | null,
  offset = 0,
): CompiledFilter {
  if (
    !filter || (typeof filter === "object" && Object.keys(filter).length === 0)
  ) {
    return { text: "", params: [] };
  }
  if (!isPlainObject(filter)) {
    throw new Error("Filter must be an object.");
  }
  const params: unknown[] = [];
  const text = compileObject(metadata, filter, params, offset);
  return { text: text ? `WHERE ${text}` : "", params };
}
