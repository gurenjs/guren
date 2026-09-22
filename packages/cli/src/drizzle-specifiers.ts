import type { SchemaDialect } from './schema-parser'

/**
 * The `@guren/orm` subpath re-exporting each dialect's builders wholesale: where
 * `ensure*Imports` merges new builders, and a signal for `detectSchemaDialect`.
 * `tests/drizzle-specifiers.test.ts` fails on an ORM `./drizzle*` export missing here.
 */
export const DIALECT_BARRELS = {
  sqlite: '@guren/orm/drizzle/sqlite',
  pg: '@guren/orm/drizzle/pg',
  mysql: '@guren/orm/drizzle/mysql',
} as const satisfies Record<SchemaDialect, string>

/** The mixed-dialect barrel older apps still import from (`packages/orm/src/drizzle.ts`). */
export const MIXED_DRIZZLE_BARREL = '@guren/orm/drizzle'

const ORM_DRIZZLE_SPECIFIERS: ReadonlySet<string> = new Set([MIXED_DRIZZLE_BARREL, ...Object.values(DIALECT_BARRELS)])

/**
 * Whether an import from `specifier` binds drizzle's own builders under their drizzle
 * names: `drizzle-orm` itself, or an `@guren/orm` barrel re-exporting it.
 */
export function isDrizzleBuilderSpecifier(specifier: string): boolean {
  return specifier === 'drizzle-orm' || specifier.startsWith('drizzle-orm/') || ORM_DRIZZLE_SPECIFIERS.has(specifier)
}
