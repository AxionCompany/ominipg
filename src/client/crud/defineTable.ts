import type {
  JsonSchema,
  TableKeyDefinition,
  TableTimestampColumns,
  TableTimestampConfig,
  TableSchemaConfig,
  WritableRowForTable,
  CrudRow,
} from "./types.ts";

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

type ConstifyArray<T extends readonly unknown[]> =
  number extends T["length"]
    ? readonly Constify<T[number]>[]
    : { readonly [K in keyof T]: Constify<T[K]> };

type Constify<T> = T extends Primitive ? T
  : T extends (...args: unknown[]) => unknown ? T
  : T extends readonly unknown[] ? ConstifyArray<T>
  : T extends unknown[] ? ConstifyArray<T>
  : T extends Map<infer K, infer V> ? ReadonlyMap<Constify<K>, Constify<V>>
  : T extends Set<infer Item> ? ReadonlySet<Constify<Item>>
  : T extends object ? { readonly [K in keyof T]: Constify<T[K]> }
  : T;

type Simplify<T> = { [K in keyof T]: T[K] } extends infer O ? {
  [K in keyof O]: O[K];
} : never;

type KeysInput =
  | readonly TableKeyDefinition[]
  | TableKeyDefinition[];

type TimestampsInput = boolean | TableTimestampConfig | undefined;

type DefaultsInput = Readonly<Record<string, unknown | (() => unknown)>>;

export type SchemaConfigInput<
  Schema,
  Keys extends KeysInput,
  Timestamps extends TimestampsInput = undefined,
  Defaults extends DefaultsInput | undefined = undefined,
> = {
  schema: Schema;
  keys: Keys;
  timestamps?: Timestamps;
  /**
   * Default values to apply on insert when a field is not provided.
   * Values may be static or factory functions invoked at runtime.
   */
  defaults?: Defaults;
};

type NormalizeKeys<K> = K extends readonly TableKeyDefinition[] ? K
  : K extends TableKeyDefinition[] ? readonly TableKeyDefinition[]
  : never;

type NormalizeTimestamps<T> = T extends boolean | TableTimestampConfig
  ? TableTimestampColumns
  : T extends undefined ? undefined
  : never;

type FrozenConfig<C> = C extends SchemaConfigInput<
  infer Schema,
  infer Keys extends KeysInput,
  infer Timestamps extends TimestampsInput,
  infer Defaults extends DefaultsInput | undefined
> ? Schema extends JsonSchema
  ? NormalizeKeys<Keys> extends never ? never
  : TableSchemaConfig<
    Constify<Schema>,
    NormalizeKeys<Keys>,
    NormalizeTimestamps<Timestamps>,
    Constify<Defaults>
  >
  : never
  : never;

type FrozenConfigMap<S extends Record<string, SchemaConfigInput<JsonSchema, KeysInput, TimestampsInput, DefaultsInput | undefined>>> = {
  readonly [K in keyof S]: FrozenConfig<S[K]>;
};

type FrozenSchemas<
  S extends Record<
    string,
    SchemaConfigInput<JsonSchema, KeysInput, TimestampsInput, DefaultsInput | undefined>
  >,
> = {
  readonly [K in keyof S]: FrozenConfig<S[K]> & {
    readonly $inferSelect: Simplify<CrudRow<FrozenConfigMap<S>, K>>;
    readonly $inferInsert: Simplify<WritableRowForTable<FrozenConfigMap<S>, K>>;
  };
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = (value as Record<string, unknown>)[key];
      if (child && typeof child === "object" && !Object.isFrozen(child)) {
        deepFreeze(child);
      }
    }
  }
  return value;
}

function toReadonlyArray<T>(values: readonly T[] | T[]): readonly T[] {
  return Array.isArray(values) ? [...values] as const : values;
}

function toReadonlyKeys(
  keys: readonly TableKeyDefinition[] | TableKeyDefinition[],
): readonly TableKeyDefinition[] {
  const list = Array.isArray(keys) ? keys : [...keys];
  return list.map((key) => {
    const frozen = {
      property: key.property,
      ...(key.$ref ? { $ref: key.$ref } : {}),
    } as TableKeyDefinition;
    return deepFreeze(frozen);
  }) as readonly TableKeyDefinition[];
}

const DEFAULT_TIMESTAMP_COLUMNS: TableTimestampColumns = Object.freeze({
  createdAt: "created_at",
  updatedAt: "updated_at",
}) as TableTimestampColumns;

function normalizeTimestamps(
  value: TimestampsInput,
): TableTimestampColumns | undefined {
  if (!value) return undefined;
  if (value === true) return DEFAULT_TIMESTAMP_COLUMNS;
  const createdAt = value.createdAt ?? DEFAULT_TIMESTAMP_COLUMNS.createdAt;
  const updatedAt = value.updatedAt ?? DEFAULT_TIMESTAMP_COLUMNS.updatedAt;
  return Object.freeze({ createdAt, updatedAt }) as TableTimestampColumns;
}

/**
 * Defines database table schemas with JSON Schema and generates type-safe CRUD types.
 * 
 * This function creates immutable schema definitions that are used to generate
 * TypeScript types and CRUD APIs. Each table schema includes:
 * - JSON Schema for validation
 * - Primary key definitions
 * - Optional timestamp configuration
 * - Optional default values
 * 
 * The returned schemas include type inference helpers (`$inferSelect`, `$inferInsert`)
 * for extracting TypeScript types from the schema definitions.
 * 
 * @typeParam S - The schema configuration object type
 * @param schemas - Object mapping table names to schema configurations
 * @returns Frozen schema definitions with type inference helpers
 * 
 * @example
 * ```typescript
 * const schemas = defineSchema({
 *   users: {
 *     schema: {
 *       type: "object",
 *       properties: {
 *         id: { type: "string" },
 *         name: { type: "string" },
 *         email: { type: "string" },
 *         age: { type: "number" }
 *       },
 *       required: ["id", "name", "email"]
 *     },
 *     keys: [{ property: "id" }],
 *     timestamps: true
 *   },
 *   posts: {
 *     schema: {
 *       type: "object",
 *       properties: {
 *         id: { type: "string" },
 *         title: { type: "string" },
 *         authorId: { type: "string" }
 *       },
 *       required: ["id", "title", "authorId"]
 *     },
 *     keys: [{ property: "id" }],
 *     timestamps: { createdAt: "created_at", updatedAt: "updated_at" }
 *   }
 * });
 * 
 * // Type inference
 * type User = typeof schemas.users.$inferSelect;
 * type NewUser = typeof schemas.users.$inferInsert;
 * ```
 * 
 * @example
 * ```typescript
 * // With default values
 * const schemas = defineSchema({
 *   users: {
 *     schema: {
 *       type: "object",
 *       properties: { id: { type: "string" }, status: { type: "string" } },
 *       required: ["id"]
 *     },
 *     keys: [{ property: "id" }],
 *     defaults: {
 *       status: "active",
 *       createdAt: () => new Date().toISOString()
 *     }
 *   }
 * });
 * ```
 */
export function defineSchema<
  const S extends Record<
    string,
    SchemaConfigInput<
      JsonSchema,
      KeysInput,
      TimestampsInput,
      DefaultsInput | undefined
    >
  >,
>(schemas: S): FrozenSchemas<S> {
  const result = {} as Record<string, unknown>;
  for (const tableName of Object.keys(schemas) as Array<keyof S>) {
    const config = schemas[tableName];
    const defaultsValue = config.defaults;
    const normalizedDefaults = defaultsValue === undefined
      ? undefined
      : deepFreeze(Object.assign({}, defaultsValue)) as Constify<
        typeof defaultsValue
      >;
    const frozenConfig = deepFreeze({
      schema: deepFreeze(structuredClone(config.schema)) as
        Constify<S[typeof tableName]["schema"]>,
      keys: toReadonlyArray(
        toReadonlyKeys(config.keys as TableKeyDefinition[]),
      ) as NormalizeKeys<S[typeof tableName]["keys"]>,
      timestamps: normalizeTimestamps(config.timestamps) as NormalizeTimestamps<
        S[typeof tableName]["timestamps"]
      >,
      defaults: normalizedDefaults,
    }) as FrozenConfig<S[typeof tableName]>;
    result[tableName as string] = frozenConfig;
  }
  return Object.freeze(result) as FrozenSchemas<S>;
}

