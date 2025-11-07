import { z } from "npm:zod@3.23.8";
import type {
  CrudSchemas,
  ForeignKey,
  JsonPointer,
  JsonSchema,
  RelationConfig,
  TableMetadata,
  TableMetadataMap,
} from "./types.ts";

interface KeyInfo {
  fields: string[];
  order: string[];
  schema: JsonSchema;
}

interface RelationView {
  mode: "object" | "array";
  targetTable: string;
}

type RootSchema = { $defs: Record<string, JsonSchema> };

type SchemaMap = Record<string, JsonSchema>;

const POINTER_ESCAPE_REGEXP = /~[01]/g;

const POINTER_UNESCAPE: Record<string, string> = {
  "~0": "~",
  "~1": "/",
};

function unescapePointerSegment(segment: string): string {
  return segment.replace(
    POINTER_ESCAPE_REGEXP,
    (match) => POINTER_UNESCAPE[match],
  );
}

function isReadOnlyProperty(schema: JsonSchema): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const { readOnly } = schema as { readOnly?: boolean };
  return Boolean(readOnly);
}

function collectProperties(schema: JsonSchema): Record<string, JsonSchema> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }
  const { properties } = schema as { properties?: SchemaMap };
  return properties ?? {};
}

function collectWritableProperties(
  schema: JsonSchema,
): Record<string, JsonSchema> {
  const properties = collectProperties(schema);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }
  const writableEntries = Object.entries(properties).filter(([, value]) =>
    !isReadOnlyProperty(value)
  );
  return Object.fromEntries(writableEntries);
}

function parseRefTarget(ref: string): string | null {
  if (!ref.startsWith("#/$defs/")) return null;
  const path = ref.slice("#/$defs/".length);
  if (!path) return null;
  const [table] = path.split("/");
  if (!table) return null;
  return table.replace(/Key$/, "");
}

function extractRef(
  schema: JsonSchema | undefined,
  root: RootSchema,
): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return null;
  }
  if ("$ref" in schema && typeof schema.$ref === "string") {
    return schema.$ref;
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const collection = (schema as Record<string, unknown>)[keyword];
    if (Array.isArray(collection)) {
      for (const entry of collection) {
        const ref = extractRef(entry as JsonSchema, root);
        if (ref) return ref;
      }
    }
  }
  return null;
}

function extractRelationView(
  propSchema: JsonSchema,
  root: RootSchema,
): RelationView | null {
  if (!isReadOnlyProperty(propSchema)) return null;
  if (!propSchema || typeof propSchema !== "object") return null;

  if (
    (propSchema as { type?: string | string[] }).type === "array" ||
    Array.isArray((propSchema as { type?: string | string[] }).type) &&
      ((propSchema as { type?: string[] }).type ?? []).includes("array") ||
    "items" in propSchema
  ) {
    const items = (propSchema as { items?: JsonSchema }).items;
    const ref = extractRef(items, root);
    if (!ref) return null;
    const target = parseRefTarget(ref);
    if (!target) return null;
    return { mode: "array", targetTable: target };
  }

  const directRef = extractRef(propSchema, root);
  if (!directRef) return null;
  const target = parseRefTarget(directRef);
  if (!target) return null;
  return { mode: "object", targetTable: target };
}

function collectRelationViewMap(
  schema: JsonSchema,
  root: RootSchema,
): Map<string, RelationView> {
  const map = new Map<string, RelationView>();
  const properties = collectProperties(schema);
  for (const [key, value] of Object.entries(properties)) {
    const view = extractRelationView(value, root);
    if (view) {
      map.set(key, view);
    }
  }
  return map;
}

function resolveRef(ref: string, root: RootSchema): JsonSchema {
  if (!ref.startsWith("#/")) {
    throw new Error(
      `Unsupported $ref '${ref}'. Only local references are supported.`,
    );
  }
  const segments = ref.slice(2).split("/").map(unescapePointerSegment);
  let current: unknown = root;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error(`Could not resolve $ref '${ref}'.`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current as JsonSchema;
}

function ensureRequired(schema: JsonSchema, tableName: string): string[] {
  const { required } = schema as { required?: string[] };
  if (!Array.isArray(required) || required.length === 0) {
    throw new Error(`Schema '${tableName}' must declare required fields.`);
  }
  return required;
}

function parsePropertyRef(
  ref: string,
): { table: string; property: string } | null {
  if (!ref.startsWith("#/$defs/")) return null;
  const pointer = ref.slice("#/$defs/".length);
  const [definition, rest] = pointer.split("/properties/");
  if (!definition || !rest) return null;
  const table = definition.endsWith("Key")
    ? definition.slice(0, -3)
    : definition;
  return { table, property: rest.split("/")[0] };
}

function collectForeignKeys(
  _tableName: string,
  schema: JsonSchema,
  _root: RootSchema,
  keyInfo: Map<string, KeyInfo>,
): ForeignKey[] {
  const props = collectProperties(schema);
  const fkMaps = new Map<string, Map<string, string>>();

  for (const [propName, propSchema] of Object.entries(props)) {
    if (!propSchema || typeof propSchema !== "object") continue;
    let ref: string | undefined;
    if (
      "$ref" in propSchema &&
      typeof (propSchema as { $ref?: string }).$ref === "string"
    ) {
      ref = (propSchema as { $ref: string }).$ref;
    }
    if (!ref) continue;
    const parsed = parsePropertyRef(ref);
    if (!parsed) continue;
    const { table: targetTable, property: targetField } = parsed;
    if (!keyInfo.has(targetTable)) continue;
    if (!fkMaps.has(targetTable)) {
      fkMaps.set(targetTable, new Map());
    }
    fkMaps.get(targetTable)!.set(targetField, propName);
  }

  const fks: ForeignKey[] = [];
  for (const [targetTable, fieldMap] of fkMaps) {
    const info = keyInfo.get(targetTable);
    if (!info) continue;
    const localFields: string[] = [];
    for (const targetField of info.order) {
      const localField = fieldMap.get(targetField);
      if (!localField) {
        localFields.length = 0;
        break;
      }
      localFields.push(localField);
    }
    if (localFields.length === info.order.length) {
      fks.push({
        targetTable,
        localFields,
        targetFields: [...info.order],
      });
    }
  }

  return fks;
}

function deriveRelationName(
  type: RelationConfig["type"],
  targetTable: string,
  localFields: string[],
): string {
  if (type === "belongsTo" && localFields.length === 1) {
    const local = localFields[0];
    if (local.toLowerCase().endsWith("id")) {
      return local.slice(0, -2) || targetTable;
    }
    return local;
  }
  if (type === "hasMany") {
    return `${targetTable}`;
  }
  if (type === "manyToMany") {
    return `${targetTable}`;
  }
  return targetTable;
}

function jsonSchemaToZod(schema: JsonSchema, root: RootSchema): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") {
    return z.any();
  }

  if ("$ref" in schema && typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, root);
    return jsonSchemaToZod(resolved, root);
  }

  const unionMembers = (schema as { anyOf?: JsonSchema[] }).anyOf
    ?? (schema as { oneOf?: JsonSchema[] }).oneOf;
  if (Array.isArray(unionMembers) && unionMembers.length > 0) {
    const zods = unionMembers.map((member) => jsonSchemaToZod(member, root));
    const nonNullMembers = zods.filter((member) => !(member instanceof z.ZodNull));
    const hasNull = nonNullMembers.length !== zods.length;
    if (nonNullMembers.length === 0) {
      return z.null();
    }
    const union = nonNullMembers.length === 1
      ? nonNullMembers[0]
      : z.union(nonNullMembers as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    return hasNull ? union.nullable() : union;
  }

  const type = (schema as { type?: string | string[] }).type;

  if (Array.isArray(type)) {
    if (type.length === 0) {
      return z.any();
    }
    if (type.length === 1) {
      const single = { ...schema, type: type[0] } as JsonSchema;
      return jsonSchemaToZod(single, root);
    }
    const [first, second, ...rest] = type;
    const unionMembers = [
      jsonSchemaToZod({ ...schema, type: first } as JsonSchema, root),
      jsonSchemaToZod({ ...schema, type: second } as JsonSchema, root),
      ...rest.map((t) =>
        jsonSchemaToZod({ ...schema, type: t } as JsonSchema, root)
      ),
    ] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]];
    return z.union(unionMembers);
  }

  switch (type) {
    case "string": {
      if (
        "enum" in schema && Array.isArray(schema.enum) && schema.enum.length > 0
      ) {
        const enumValues = schema.enum as string[];
        if (enumValues.length === 1) {
          return z.literal(enumValues[0]);
        }
        return z.enum(enumValues as [string, string, ...string[]]);
      }
      let base = z.string();
      if ("minLength" in schema && typeof schema.minLength === "number") {
        base = base.min(schema.minLength);
      }
      if ("maxLength" in schema && typeof schema.maxLength === "number") {
        base = base.max(schema.maxLength);
      }
      const format = (schema as { format?: string }).format;
      if (format === "date-time" || format === "date") {
        const dateInstance = z.instanceof(Date).transform((value) =>
          value.toISOString()
        );
        return z.union([base, dateInstance]);
      }
      return base;
    }
    case "number":
    case "integer": {
      let zz = z.number();
      if (type === "integer") {
        zz = zz.int();
      }
      if ("minimum" in schema && typeof schema.minimum === "number") {
        zz = zz.min(schema.minimum);
      }
      if ("maximum" in schema && typeof schema.maximum === "number") {
        zz = zz.max(schema.maximum);
      }
      return zz;
    }
    case "boolean":
      return z.boolean();
    case "array": {
      const items = (schema as { items?: JsonSchema | JsonSchema[] }).items;
      if (!items) return z.array(z.any());
      if (Array.isArray(items)) {
        return z.tuple(items.map((item) => jsonSchemaToZod(item, root)) as []);
      }
      return z.array(jsonSchemaToZod(items, root));
    }
    case "null":
      return z.null();
    case "object":
    default: {
      const props = collectProperties(schema);
      const required = new Set(
        (schema as { required?: string[] }).required ?? [],
      );
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, propSchema] of Object.entries(props)) {
        const propZod = jsonSchemaToZod(propSchema, root);
        shape[key] = required.has(key) ? propZod : propZod.optional();
      }
      const base = z.object(shape);
      if ("additionalProperties" in schema) {
        const additional =
          (schema as { additionalProperties?: boolean | JsonSchema })
            .additionalProperties;
        if (additional === false) {
          return base.strict();
        }
        if (additional && typeof additional === "object") {
          return base.catchall(jsonSchemaToZod(additional, root));
        }
        return base.passthrough();
      }
      return base.passthrough();
    }
  }
}

function buildRootSchema(
  schemas: CrudSchemas,
  keyInfo: Map<string, KeyInfo>,
): RootSchema {
  const defs: Record<string, JsonSchema> = {};
  for (const [tableName, config] of Object.entries(schemas)) {
    defs[tableName] = config.schema;
    const info = keyInfo.get(tableName);
    if (info) {
      defs[`${tableName}Key`] = info.schema;
    }
  }
  return { $defs: defs } as RootSchema;
}

function buildKeyInfo(
  schemas: CrudSchemas,
): Map<string, KeyInfo> {
  const map = new Map<string, KeyInfo>();
  for (const [tableName, config] of Object.entries(schemas)) {
    const keys = config.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error(
        `Table '${tableName}' must declare at least one key in the 'keys' array.`,
      );
    }
    const tableProps = collectProperties(config.schema);
    const tableRequired = new Set(ensureRequired(config.schema, tableName));
    const seen = new Set<string>();
    const order: string[] = [];
    const keyProperties: Record<string, JsonSchema> = {};

    for (const descriptor of keys) {
      const property = descriptor.property;
      if (!property) {
        throw new Error(
          `Table '${tableName}' has a key entry without 'property'.`,
        );
      }
      if (seen.has(property)) {
        throw new Error(
          `Table '${tableName}' declares duplicate key property '${property}'.`,
        );
      }
      if (!tableProps[property]) {
        throw new Error(
          `Primary key field '${property}' is not present in table '${tableName}'.`,
        );
      }
      if (!tableRequired.has(property)) {
        throw new Error(
          `Primary key field '${property}' must be marked as required in schema '${tableName}'.`,
        );
      }
      seen.add(property);
      order.push(property);
      const pointer = descriptor.$ref
        ? descriptor.$ref
        : (`#/$defs/${tableName}/properties/${property}` as JsonPointer);
      keyProperties[property] = { $ref: pointer } as JsonSchema;
    }

    const keySchema: JsonSchema = {
      type: "object",
      properties: keyProperties,
      required: [...order],
      additionalProperties: false,
    };

    map.set(tableName, {
      fields: [...order],
      order: [...order],
      schema: keySchema,
    });
  }
  return map;
}

function attachRelations(
  map: TableMetadataMap,
  viewMaps: Map<string, Map<string, RelationView>>,
): void {
  // belongsTo already added via foreign keys; now add reverse hasMany and manyToMany
  for (const metadata of map.values()) {
    const viewMap = viewMaps.get(metadata.tableName) ?? new Map();
    // ensure belongsTo relations exist
    for (const fk of metadata.foreignKeys) {
      let name: string;
      const desired = [...viewMap.entries()].find(([, view]) =>
        view.mode === "object" && view.targetTable === fk.targetTable
      );
      if (desired) {
        name = desired[0];
        viewMap.delete(name);
      } else {
        name = deriveRelationName(
          "belongsTo",
          fk.targetTable,
          fk.localFields,
        );
      }
      metadata.relations.push({
        name,
        type: "belongsTo",
        localFields: [...fk.localFields],
        targetTable: fk.targetTable,
        targetFields: [...fk.targetFields],
      });
    }
  }

  // hasMany relations
  for (const [tableName, metadata] of map) {
    const viewMap = viewMaps.get(tableName) ?? new Map();
    for (const [otherName, otherMeta] of map) {
      if (tableName === otherName) continue;
      for (const fk of otherMeta.foreignKeys) {
        if (fk.targetTable !== tableName) continue;
        let relationName: string;
        const desired = [...viewMap.entries()].find(([, view]) =>
          view.mode === "array" && view.targetTable === otherName
        );
        if (desired) {
          relationName = desired[0];
          viewMap.delete(relationName);
        } else {
          relationName = deriveRelationName(
            "hasMany",
            otherName,
            fk.localFields,
          );
        }
        metadata.relations.push({
          name: relationName,
          type: "hasMany",
          localFields: [...fk.targetFields],
          targetTable: otherName,
          targetFields: [...fk.localFields],
        });
      }
    }
  }

  // many-to-many detection via join tables
  for (const [candidateName, candidateMeta] of map) {
    if (candidateMeta.foreignKeys.length !== 2) continue;
    const [fkA, fkB] = candidateMeta.foreignKeys;
    const tableA = map.get(fkA.targetTable);
    const tableB = map.get(fkB.targetTable);
    if (!tableA || !tableB) continue;
    const viewMapA = viewMaps.get(tableA.tableName) ?? new Map();
    const viewMapB = viewMaps.get(tableB.tableName) ?? new Map();

    const desiredA = [...viewMapA.entries()].find(([, view]) =>
      view.mode === "array" && view.targetTable === fkB.targetTable
    );
    const relationNameA = desiredA ? desiredA[0] : deriveRelationName(
      "manyToMany",
      fkB.targetTable,
      fkA.targetFields,
    );
    if (desiredA) viewMapA.delete(desiredA[0]);
    tableA.relations.push({
      name: relationNameA,
      type: "manyToMany",
      localFields: [...fkA.targetFields],
      targetTable: fkB.targetTable,
      targetFields: [...fkB.targetFields],
      viaTable: candidateName,
      viaLocalFields: [...fkA.localFields],
      viaTargetFields: [...fkB.localFields],
    });

    const desiredB = [...viewMapB.entries()].find(([, view]) =>
      view.mode === "array" && view.targetTable === fkA.targetTable
    );
    const relationNameB = desiredB ? desiredB[0] : deriveRelationName(
      "manyToMany",
      fkA.targetTable,
      fkB.targetFields,
    );
    if (desiredB) viewMapB.delete(desiredB[0]);
    tableB.relations.push({
      name: relationNameB,
      type: "manyToMany",
      localFields: [...fkB.targetFields],
      targetTable: fkA.targetTable,
      targetFields: [...fkA.targetFields],
      viaTable: candidateName,
      viaLocalFields: [...fkB.localFields],
      viaTargetFields: [...fkA.localFields],
    });
  }
}

export function buildMetadataMap(
  schemas: CrudSchemas,
): TableMetadataMap {
  const map: TableMetadataMap = new Map();
  const keyInfo = buildKeyInfo(schemas);
  const root = buildRootSchema(schemas, keyInfo);
  const viewMaps = new Map<string, Map<string, RelationView>>();

  for (const [tableName, config] of Object.entries(schemas)) {
    const views = collectRelationViewMap(config.schema, root);
    viewMaps.set(tableName, views);
  }

  for (const [tableName, config] of Object.entries(schemas)) {
    const info = keyInfo.get(tableName);
    if (!info) continue;

    const relationViews = viewMaps.get(tableName) ?? new Map();
    const allProperties = collectProperties(config.schema);
    const writableProperties = collectWritableProperties(config.schema);
    const writableColumns = new Set(Object.keys(writableProperties));
    for (const keyField of info.order) {
      writableColumns.add(keyField);
    }
    const foreignKeys = collectForeignKeys(
      tableName,
      config.schema,
      root,
      keyInfo,
    );
    const timestampConfig = config.timestamps;
    if (timestampConfig) {
      for (const column of [timestampConfig.createdAt, timestampConfig.updatedAt]) {
        if (!allProperties[column]) {
          throw new Error(
            `Timestamp column '${column}' is not present in table '${tableName}'.`,
          );
        }
        writableColumns.add(column);
      }
    }
    const configDefaults = (config as unknown as {
      defaults?: Record<string, unknown | (() => unknown)>;
    }).defaults;
    let staticDefaults: Record<string, unknown> | undefined;
    let dynamicDefaults: Record<string, () => unknown> | undefined;
    if (configDefaults) {
      for (const [key, value] of Object.entries(configDefaults)) {
        if (typeof value === "function") {
          if (!dynamicDefaults) dynamicDefaults = {};
          dynamicDefaults[key] = value as () => unknown;
        } else {
          if (!staticDefaults) staticDefaults = {};
          staticDefaults[key] = value;
        }
      }
    }
    const zodSchema = jsonSchemaToZod(config.schema, root);
    const zodPartial = zodSchema instanceof z.ZodObject
      ? zodSchema.partial()
      : zodSchema;

    const metadata: TableMetadata = {
      tableName,
      schema: config.schema,
      keySchema: info.schema,
      keyFields: [...info.fields],
      keyOrder: [...info.order],
      properties: allProperties,
      writableColumns,
      foreignKeys,
      relations: [],
      readOnlyProperties: new Set(relationViews.keys()),
      timestamps: timestampConfig,
      zod: zodSchema,
      zodPartial,
      staticDefaults,
      dynamicDefaults,
    };

    map.set(tableName, metadata);
  }

  attachRelations(map, viewMaps);

  return map;
}
