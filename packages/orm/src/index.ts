import './instance-guard'
export { Model, defineModel } from './Model'
export { ModelNotFoundException } from './ModelNotFoundException'
export { MassAssignmentException } from './MassAssignmentException'
export type {
  PlainObject,
  InferModelRecord,
  InferModelInsert,
  WhereClause,
  OrderDirection,
  OrderDefinition,
  OrderByInput,
  OrderByClause,
  FindManyOptions,
  PaginateOptions,
  PaginatedResult,
  ModelPaginationMeta,
  ORMAdapter,
  TransactionHandle,
  TransactionModelScope,
  CastType,
  HasManyRelationResult,
  HasOneRelationResult,
  BelongsToRelationResult,
  BelongsToManyRelationResult,
  HasManyThroughRelationResult,
  HasManyRecord,
  HasOneRecord,
  BelongsToRecord,
  BelongsToRequiredRecord,
  BelongsToManyRecord,
  HasManyThroughRecord,
  MorphManyRelationResult,
  MorphManyRecord,
  MorphToRelationResult,
  MorphToRecord,
  WithRelations,
} from './Model'
export { QueryBuilder } from './QueryBuilder'
export type {
  WhereOperator,
  WhereCondition,
  SimpleCondition,
  GroupCondition,
  ORMAdapterAdvanced,
  QueryBuilderOptions,
} from './QueryBuilder'
export { SoftDeletes } from './SoftDeletes'
export type { SoftDeletesStatic } from './SoftDeletes'
export { executeHook } from './hooks'
export type { ModelHooks, HookName, HookCallback } from './hooks'
export { DrizzleAdapter } from './adapters/drizzle-adapter'
export { buildDrizzleConditions } from './adapters/drizzle-conditions'
export { createPostgresDatabase } from './postgres'
export type { PostgresDatabase, PostgresDatabaseOptions } from './postgres'
export { createMySqlDatabase } from './mysql'
export type { MySqlDatabase, MySqlDatabaseOptions } from './mysql'
export { createSqliteDatabase } from './sqlite'
export type { MigrationStatusEntry } from './migration-utils'
export type { SqliteDatabase, SqliteDatabaseOptions } from './sqlite'
export { createD1Database } from './d1'
export type { D1DatabaseHandle, D1DatabaseOptions } from './d1'
export { createAwsDataApiDatabase } from './aws-data-api'
export type { AwsDataApiDatabase, AwsDataApiDatabaseOptions } from './aws-data-api'
export { runSeeders, defineSeeder, loadSeeders } from './seeder'
export type {
  SeederContext,
  SeederHandler,
  PostgresSeederContext,
  MySqlSeederContext,
  SqliteSeederContext,
  AwsDataApiSeederContext,
} from './seeder'

// Accessors & Mutators
export { applyAccessors, applyMutators } from './attributes'
export type { AccessorFn, MutatorFn, AccessorDefinitions, MutatorDefinitions } from './attributes'

// Serialization
export { serializeRecord, serializeRecords } from './serialization'

// Observers
export { executeObservers } from './ModelObserver'
export type { ModelObserver, ModelObserverConstructor } from './ModelObserver'

// Global Scopes
export { GlobalScopeRegistry } from './GlobalScopeRegistry'
export type { ScopeFunction } from './GlobalScopeRegistry'
