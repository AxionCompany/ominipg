import type { FromSchema, JSONSchema } from "npm:json-schema-to-ts@3.1.1";
import type { ZodTypeAny } from "npm:zod@3.23.8";

export type JsonSchema = JSONSchema;

export type JsonPointer = `#${string}`;

export interface TableRelationDefinition {
  readonly name: string;
  readonly type: "belongsTo" | "hasMany" | "manyToMany";
  readonly target: string;
}

export interface TableTimestampConfig {
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface TableTimestampColumns {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TableKeyDefinition {
  readonly property: string;
  readonly $ref?: JsonPointer;
}

export type TableSchemaConfig<
  Schema extends JsonSchema,
  Keys extends readonly TableKeyDefinition[],
  Timestamps extends TableTimestampColumns | undefined = undefined,
> = {
  readonly schema: Schema;
  readonly keys: Keys;
  readonly timestamps?: Timestamps;
};

export type AnyTableSchemaConfig = TableSchemaConfig<
  JsonSchema,
  readonly TableKeyDefinition[],
  TableTimestampColumns | undefined
>;

export type CrudSchemas = Record<string, AnyTableSchemaConfig>;

export type InferRow<Schema extends JsonSchema> = FromSchema<Schema>;

type PropertiesOf<Schema> = Schema extends { properties: infer Props }
  ? Props extends Record<string, JsonSchema> ? Props
  : Record<string, JsonSchema>
  : Record<string, JsonSchema>;

type ReadOnlyProperty<Prop> = Prop extends { readOnly: true } ? true : false;

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

type SchemaDefinitionMap<Schemas extends CrudSchemas> = {
  [K in keyof Schemas]: Schemas[K]["schema"];
};

type KeyNames<Schemas extends CrudSchemas, TableName extends keyof Schemas> =
  Schemas[TableName]["keys"][number]["property"];

type AugmentedSchema<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = Schemas[TableName]["schema"] & {
  $defs: SchemaDefinitionMap<Schemas>;
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
    ? ReadonlyArray<CrudRow<Schemas, Target>>
    : RelationEntryForKey<Schemas, TableName, K> extends {
      target: infer Target extends keyof Schemas;
      mode: "object";
    } ? CrudRow<Schemas, Target> | null
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

type CrudBaseRow<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = StripIndex<FromSchema<AugmentedSchema<Schemas, TableName>>>;

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

export type CrudRow<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = Omit<CrudBaseRow<Schemas, TableName>, RelationKeysForTable<Schemas, TableName>> &
  RelationSubset<Schemas, TableName>;

export type WritableRowForTable<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = Omit<
  CrudRow<Schemas, TableName>,
  CrudTableRelationKeys<Schemas, TableName>
>;

type KeySelection<
  Schemas extends CrudSchemas,
  TableName extends keyof Schemas,
> = Extract<KeyNames<Schemas, TableName>, keyof CrudRow<Schemas, TableName>>;

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
  foreignKeys: ForeignKey[];
  relations: RelationConfig[];
  readOnlyProperties: Set<string>;
  timestamps?: TableTimestampColumns;
  zod?: ZodTypeAny;
  zodPartial?: ZodTypeAny;
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

export type CrudTableApi<
  Row,
  Relations,
  Writable,
  PopulateKey extends string = string,
> = {
  find(
    filter?: CrudFilter | null,
    options?: CrudQueryOptions<PopulateKey>,
  ): Promise<Array<Row & Partial<Relations>>>;
  findOne(
    filter?: CrudFilter | null,
    options?: CrudQueryOptions<PopulateKey>,
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

export type CrudApi<Schemas extends CrudSchemas> = {
  [TableName in keyof Schemas]: CrudTableApi<
    CrudRow<Schemas, TableName>,
    CrudTableRelations<Schemas, TableName>,
    WritableRowForTable<Schemas, TableName>,
    CrudTablePopulateKey<Schemas, TableName>
  >;
};
