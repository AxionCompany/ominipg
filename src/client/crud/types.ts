import type { FromSchema, JSONSchema } from "npm:json-schema-to-ts@3.1.1";
import type { ZodTypeAny } from "npm:zod@3.23.8";

/**
 * JSON Schema type definition.
 * 
 * Represents a JSON Schema object used for table schema definitions and validation.
 * This is an alias for the JSONSchema type from json-schema-to-ts.
 */
export type JsonSchema = JSONSchema;

export type JsonPointer = `#${string}`;

export interface TableRelationDefinition {
  readonly name: string;
  readonly type: "belongsTo" | "hasMany" | "manyToMany";
  readonly target: string;
}

/**
 * Configuration for automatic timestamp columns.
 * 
 * When enabled, Ominipg will automatically manage `createdAt` and `updatedAt`
 * columns. You can customize the column names or use the defaults.
 * 
 * @example
 * ```typescript
 * // Use defaults (created_at, updated_at)
 * timestamps: true
 * 
 * // Custom column names
 * timestamps: {
 *   createdAt: "created_at",
 *   updatedAt: "modified_at"
 * }
 * ```
 */
export interface TableTimestampConfig {
  /** Column name for creation timestamp (default: "created_at") */
  readonly createdAt?: string;
  /** Column name for update timestamp (default: "updated_at") */
  readonly updatedAt?: string;
}

/**
 * Normalized timestamp column configuration.
 * 
 * This is the normalized form of TableTimestampConfig where both column names
 * are required (after applying defaults).
 */
export interface TableTimestampColumns {
  /** Column name for creation timestamp */
  readonly createdAt: string;
  /** Column name for update timestamp */
  readonly updatedAt: string;
}

/**
 * Primary key definition for a table.
 * 
 * Defines which properties form the primary key of a table. Supports both
 * simple keys (single property) and composite keys (multiple properties).
 * 
 * @example
 * ```typescript
 * // Simple key
 * keys: [{ property: "id" }]
 * 
 * // Composite key
 * keys: [
 *   { property: "userId" },
 *   { property: "postId" }
 * ]
 * ```
 */
export interface TableKeyDefinition {
  /** The property name that forms part of the primary key */
  readonly property: string;
  /** Optional JSON pointer reference for nested properties */
  readonly $ref?: JsonPointer;
}

export type DefaultMap = Readonly<Record<string, unknown | (() => unknown)>>;

/**
 * Complete table schema configuration.
 * 
 * Defines all aspects of a table schema including validation, keys, timestamps,
 * and default values. This is the normalized form used internally after
 * processing user-provided schema definitions.
 * 
 * @typeParam Schema - The JSON Schema for the table
 * @typeParam Keys - The primary key definitions
 * @typeParam Timestamps - Timestamp column configuration (if enabled)
 * @typeParam Defaults - Default values map (if provided)
 */
export type TableSchemaConfig<
  Schema extends JsonSchema,
  Keys extends readonly TableKeyDefinition[],
  Timestamps extends TableTimestampColumns | undefined = undefined,
  Defaults extends DefaultMap | undefined = undefined,
> = {
  readonly schema: Schema;
  readonly keys: Keys;
  readonly timestamps?: Timestamps;
  /**
   * Default values to apply when inserting rows (create/upsert insert path).
   * Values may be static or factory functions that produce the value at runtime.
   * Only applied if the field is undefined in the provided data.
   */
  readonly defaults?: Defaults;
};

export type AnyTableSchemaConfig = TableSchemaConfig<
  JsonSchema,
  readonly TableKeyDefinition[],
  TableTimestampColumns | undefined,
  DefaultMap | undefined
>;

/**
 * Collection of table schema definitions.
 * 
 * Maps table names to their schema configurations. Used as input to
 * `defineSchema()` and `createCrudApi()`.
 * 
 * @example
 * ```typescript
 * const schemas: CrudSchemas = {
 *   users: { schema: {...}, keys: [{ property: "id" }] },
 *   posts: { schema: {...}, keys: [{ property: "id" }] }
 * };
 * ```
 */
export type CrudSchemas = Record<string, AnyTableSchemaConfig>;

/**
 * Infers TypeScript type from a JSON Schema.
 * 
 * Utility type that extracts the TypeScript type corresponding to a JSON Schema.
 * Used internally for type inference in CRUD operations.
 * 
 * @typeParam Schema - The JSON Schema to infer from
 */
export type InferRow<Schema extends JsonSchema> = FromSchema<Schema>;

type Simplify<T> = { [K in keyof T]: T[K] } extends infer O ? {
  [K in keyof O]: O[K];
} : never;

type PropertiesOf<Schema> = Schema extends { properties: infer Props }
  ? Props extends Record<string, JsonSchema> ? Props
  : Record<string, JsonSchema>
  : Record<string, JsonSchema>;

type SchemaProperties<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = PropertiesOf<Schemas[TableName]["schema"]>;

type PropertyForTable<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
  Key extends PropertyKey,
> = Key extends keyof SchemaProperties<Schemas, TableName>
  ? SchemaProperties<Schemas, TableName>[Key]
  : never;

type ReadOnlyProperty<Prop> = Prop extends { readOnly: true } ? true : false;

type StripReadOnlyProperties<Schema> = Schema extends { properties: infer Props }
  ? Omit<Schema, "properties"> & {
    properties: {
      [K in keyof Props as ReadOnlyProperty<Props[K]> extends true ? never : K]:
        Props[K];
    };
  }
  : Schema;

type ExtractArrayRef<Prop> = Prop extends { items: infer Items }
  ? ExtractRef<Items>
  : never;

type ExtractRef<Prop> = Prop extends { $ref: infer Ref extends string } ? Ref
  : Prop extends { anyOf: infer Members }
    ? Members extends ReadonlyArray<unknown>
      ? ExtractRef<Members[number] & JsonSchema>
    : never
  : Prop extends { oneOf: infer Members }
    ? Members extends ReadonlyArray<unknown>
      ? ExtractRef<Members[number] & JsonSchema>
    : never
  : Prop extends { allOf: infer Members }
    ? Members extends ReadonlyArray<unknown>
      ? ExtractRef<Members[number] & JsonSchema>
    : never
  : never;

type RefTarget<Ref> = Ref extends `#/$defs/${infer Table}/properties/${string}`
  ? Table
  : Ref extends `#/$defs/${infer Table}` ? Table
  : Ref extends `#/$defs/${infer Table}Key${string}` ? Table
  : never;

type IsArraySchema<Prop> = Prop extends { type: "array" } ? true
  : Prop extends { type: readonly string[] }
    ? "array" extends Prop["type"][number] ? true
    : false
  : Prop extends { items: unknown } ? true
  : false;

type RelationDescriptor<S extends CrudSchemas, Table extends keyof S, Prop> =
  ReadOnlyProperty<Prop> extends true ? (
      IsArraySchema<Prop> extends true ? (
          ExtractArrayRef<Prop> extends infer Ref extends string ? (
              RefTarget<Ref> extends infer Target extends keyof S ? {
                  mode: "array";
                  target: Target;
                }
                : never
            )
            : never
        )
        : ExtractRef<Prop> extends infer Ref extends string ? (
            RefTarget<Ref> extends infer Target extends keyof S ? {
                mode: "object";
                target: Target;
              }
              : never
          )
        : never
    )
    : never;

type RelationPropertyEntries<S extends CrudSchemas, Table extends keyof S> = {
  [K in keyof PropertiesOf<S[Table]["schema"]>]: RelationDescriptor<
    S,
    Table,
    PropertiesOf<S[Table]["schema"]>[K]
  > extends infer Descriptor
    ? Descriptor extends
      { target: infer Target extends keyof S; mode: infer Mode extends string }
      ? {
        key: K;
        target: Target;
        mode: Mode;
      }
    : never
    : never;
};

type RelationPropertyKeys<S extends CrudSchemas, Table extends keyof S> = {
  [K in keyof RelationPropertyEntries<S, Table>]:
    RelationPropertyEntries<S, Table>[K] extends never ? never
      : K;
}[keyof RelationPropertyEntries<S, Table> & string];

type RelationEntryForKey<
  S extends CrudSchemas,
  Table extends keyof S,
  K extends keyof PropertiesOf<S[Table]["schema"]>,
> = RelationPropertyEntries<S, Table>[K] extends
  { target: infer Target extends keyof S; mode: infer Mode }
  ? { target: Target; mode: Mode }
  : never;

type SchemaPropertyHasDefault<Prop> = Prop extends { default: unknown } ? true
  : false;

type SchemaDefinitionMap<Schemas extends CrudSchemas> = {
  [K in keyof Schemas]: StripReadOnlyProperties<Schemas[K]["schema"]>;
};

type KeyNames<Schemas extends CrudSchemas, TableName extends keyof Schemas> =
  Schemas[TableName]["keys"][number]["property"];

// Compute the set of table names referenced via $ref (including array item refs)
type ReferencedTablesForTable<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = {
  [K in keyof SchemaProperties<Schemas, TableName>]: (
    ExtractRef<SchemaProperties<Schemas, TableName>[K]> extends infer Ref extends string
      ? RefTarget<Ref>
      : never
  ) | (
    IsArraySchema<SchemaProperties<Schemas, TableName>[K]> extends true
      ? (
        ExtractArrayRef<SchemaProperties<Schemas, TableName>[K]> extends infer ARef extends string
          ? RefTarget<ARef>
          : never
      )
      : never
  );
}[keyof SchemaProperties<Schemas, TableName>] & keyof Schemas;

type LimitedDefs<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = {
  [K in ReferencedTablesForTable<Schemas, TableName>]: StripReadOnlyProperties<
    Schemas[K]["schema"]
  >;
};

type AugmentedSchema<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = Schemas[TableName]["schema"] & {
  // Only include referenced table schemas to keep FromSchema expansion shallow
  $defs: LimitedDefs<Schemas, TableName>;
};

export type CrudTableRelations<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = {
  [K in RelationPropertyKeys<Schemas, TableName>]: RelationEntryForKey<
    Schemas,
    TableName,
    K
  > extends { target: infer Target extends keyof Schemas; mode: "array" }
    // Use base rows for arrays to avoid recursive expansion through relations
    ? ReadonlyArray<CrudBaseRow<Schemas, Target>>
    : RelationEntryForKey<Schemas, TableName, K> extends {
      target: infer Target extends keyof Schemas;
      mode: "object";
    } ? CrudBaseRow<Schemas, Target> | null
    : never;
};

export type CrudTableRelationKeys<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = Extract<keyof CrudTableRelations<Schemas, TableName>, string>;

export type CrudTablePopulateKey<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = CrudTableRelationKeys<Schemas, TableName> extends never ? string
  : CrudTableRelationKeys<Schemas, TableName>;

type StripIndex<T> = {
  [K in keyof T as K extends string ? string extends K ? never : K
    : K extends number ? number extends K ? never : K
    : K]: T[K]
};

export type CrudBaseRow<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = ApplyFormatOverrides<
  Schemas,
  TableName,
  StripIndex<
    FromSchema<
      StripReadOnlyProperties<AugmentedSchema<Schemas, TableName>>
    >
  >
>;

type ReplaceString<Value, Replacement> = [Value] extends [never] ? never
  : [Value] extends [string] ? Replacement
  : Value extends string ? Exclude<Value, string> | Replacement
  : Value;

type FormatAdjustedValue<Prop, Value> = Prop extends { format: infer F extends string }
  ? F extends "date-time" | "date"
    ? ReplaceString<Value, Date>
    : Value
  : Value;

type ApplyFormatOverrides<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
  Row,
> = Simplify<{
  [K in keyof Row]: FormatAdjustedValue<
    PropertyForTable<Schemas, TableName, K & PropertyKey>,
    Row[K]
  >;
}>;

type RelationKeysForTable<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = CrudTableRelationKeys<Schemas, TableName> extends string
  ? CrudTableRelationKeys<Schemas, TableName>
  : never;

type RelationSubset<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = Partial<CrudTableRelations<Schemas, TableName>>;

type TimestampColumnsForTable<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = Schemas[TableName]["timestamps"] extends TableTimestampColumns
  ? Schemas[TableName]["timestamps"][keyof TableTimestampColumns]
  : never;

type DefaultKeysForTable<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = Schemas[TableName] extends { defaults?: infer Defaults }
  ? Defaults extends Record<string, unknown | (() => unknown)>
    ? keyof Defaults & string
  : never
  : never;

type SchemaDefaultKeysForTable<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = {
  [K in keyof SchemaProperties<Schemas, TableName> & string]: SchemaPropertyHasDefault<
    SchemaProperties<Schemas, TableName>[K]
  > extends true ? K : never
}[keyof SchemaProperties<Schemas, TableName> & string];

type OptionalInsertKeys<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
  BaseRow extends Record<string, unknown>,
> = Extract<
  TimestampColumnsForTable<Schemas, TableName>
    | DefaultKeysForTable<Schemas, TableName>
    | SchemaDefaultKeysForTable<Schemas, TableName>,
  keyof BaseRow
>;

type SetOptional<
  T,
  Keys extends keyof T,
> = Simplify<
  Omit<T, Keys> & Partial<Pick<T, Keys>>
>;

/**
 * Type representing a row from a CRUD table.
 * 
 * This is the inferred type for rows returned from CRUD operations (find, create, etc.).
 * It includes all properties from the schema, excluding relation keys (which are
 * replaced by relation objects when populated).
 * 
 * @typeParam Schemas - The schema definitions
 * @typeParam TableName - The name of the table
 * 
 * @example
 * ```typescript
 * const schemas = defineSchema({ users: { ... } });
 * type User = CrudRow<typeof schemas, "users">;
 * ```
 */
export type CrudRow<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = Omit<CrudBaseRow<Schemas, TableName>, RelationKeysForTable<Schemas, TableName>> &
  RelationSubset<Schemas, TableName>;

export type WritableRowForTable<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = SetOptional<
  Omit<CrudRow<Schemas, TableName>, CrudTableRelationKeys<Schemas, TableName>>,
  OptionalInsertKeys<
    Schemas,
    TableName,
    Omit<CrudRow<Schemas, TableName>, CrudTableRelationKeys<Schemas, TableName>>
  >
>;

type KeySelection<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = Extract<KeyNames<Schemas, TableName>, keyof CrudRow<Schemas, TableName>>;

/**
 * Infers the primary key type for a table.
 * 
 * Extracts the type representing the primary key fields of a table.
 * Useful for type-safe filter operations and lookups.
 * 
 * @typeParam Schemas - The schema definitions
 * @typeParam TableName - The name of the table
 * 
 * @example
 * ```typescript
 * const schemas = defineSchema({ users: { ... } });
 * type UserKey = InferKey<typeof schemas, "users">;
 * // UserKey = { id: string } (if id is the primary key)
 * ```
 */
export type InferKey<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = Pick<CrudRow<Schemas, TableName>, KeySelection<Schemas, TableName>>;

export interface ForeignKey {
  targetTable: string;
  localFields: string[];
  targetFields: string[];
}

export interface RelationConfig {
  name: string;
  type: "belongsTo" | "hasMany" | "manyToMany";
  localFields: string[];
  targetTable: string;
  targetFields: string[];
  viaTable?: string;
  viaLocalFields?: string[];
  viaTargetFields?: string[];
}

export interface TableMetadata {
  tableName: string;
  schema: JsonSchema;
  keySchema: JsonSchema;
  keyFields: string[];
  keyOrder: string[];
  properties: Record<string, JsonSchema>;
  writableColumns: ReadonlySet<string>;
  foreignKeys: ForeignKey[];
  relations: RelationConfig[];
  readOnlyProperties: Set<string>;
  timestamps?: TableTimestampColumns;
  zod?: ZodTypeAny;
  zodPartial?: ZodTypeAny;
  /** Static defaults applied on insert if field is undefined. */
  staticDefaults?: Readonly<Record<string, unknown>>;
  /** Dynamic defaults applied on insert if field is undefined. */
  dynamicDefaults?: Readonly<Record<string, () => unknown>>;
}

export type TableMetadataMap = Map<string, TableMetadata>;

export type CrudSortDirection = "asc" | "desc";

export type CrudSortSpecification =
  | { field: string; direction?: CrudSortDirection }
  | readonly [field: string, direction?: CrudSortDirection];

export interface CrudQueryOptions<PopulateKey extends string = string> {
  limit?: number;
  offset?: number;
  skip?: number;
  orderBy?: Record<string, CrudSortDirection>;
  sort?: ReadonlyArray<CrudSortSpecification>;
  select?: string[];
  populate?: ReadonlyArray<PopulateKey>;
  validateOutput?: boolean;
}

export type CrudFilter = Record<string, unknown>;

/**
 * CRUD API interface for a single table.
 * 
 * Provides type-safe CRUD operations (create, read, update, delete) with
 * support for filtering, sorting, pagination, and relation population.
 * 
 * @typeParam Row - The row type (result of CRUD operations)
 * @typeParam Relations - The relation types (when populated)
 * @typeParam Writable - The writable row type (for create/update)
 * @typeParam PopulateKey - Union of relation names that can be populated
 */
export type CrudTableApi<
  Row,
  Relations,
  Writable,
  PopulateKey extends string = string,
> = {
  // No populate → return base rows only (lighter types, avoids deep instantiation)
  find(
    filter?: CrudFilter | null,
    options?: Omit<CrudQueryOptions<PopulateKey>, "populate"> & { populate?: undefined },
  ): Promise<Array<Row>>;
  // With populate → return rows with relations
  find(
    filter: CrudFilter | null | undefined,
    options: Omit<CrudQueryOptions<PopulateKey>, "populate"> & { populate: ReadonlyArray<PopulateKey> },
  ): Promise<Array<Row & Partial<Relations>>>;
  // No populate → base row
  findOne(
    filter?: CrudFilter | null,
    options?: Omit<CrudQueryOptions<PopulateKey>, "populate"> & { populate?: undefined },
  ): Promise<Row | null>;
  // With populate → row with relations
  findOne(
    filter: CrudFilter | null | undefined,
    options: Omit<CrudQueryOptions<PopulateKey>, "populate"> & { populate: ReadonlyArray<PopulateKey> },
  ): Promise<(Row & Partial<Relations>) | null>;
  create(
    data: Writable,
    options?: { validateOutput?: boolean },
  ): Promise<Row & Partial<Relations>>;
  createMany(
    data: Writable[],
    options?: { validateOutput?: boolean },
  ): Promise<Array<Row & Partial<Relations>>>;
  update(
    filter: CrudFilter | undefined,
    data: Partial<Writable>,
    options?: { upsert?: boolean; validateOutput?: boolean },
  ): Promise<(Row & Partial<Relations>) | null>;
  updateMany(
    filter: CrudFilter | undefined,
    data: Partial<Writable>,
    options?: { upsert?: boolean; validateOutput?: boolean },
  ): Promise<{ rows: Array<Row & Partial<Relations>>; count: number }>;
  delete(
    filter: CrudFilter | undefined,
    options?: { validateOutput?: boolean },
  ): Promise<(Row & Partial<Relations>) | null>;
  deleteMany(filter: CrudFilter | undefined): Promise<{ count: number }>;
};

/**
 * Complete CRUD API for all tables in a schema.
 * 
 * Maps each table name to its CRUD API, providing type-safe access to
 * all CRUD operations across all tables.
 * 
 * @typeParam Schemas - The schema definitions
 * 
 * @example
 * ```typescript
 * const schemas = defineSchema({ users: {...}, posts: {...} });
 * const crud = createCrudApi(schemas, queryFn);
 * // crud.users and crud.posts are now available
 * ```
 */
export type CrudApi<Schemas extends CrudSchemas> = {
  [TableName in keyof Schemas]: CrudTableApi<
    CrudBaseRow<Schemas, TableName>,
    CrudTableRelations<Schemas, TableName>,
    WritableRowForTable<Schemas, TableName>,
    CrudTablePopulateKey<Schemas, TableName>
  >;
};
