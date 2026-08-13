import { and, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, notInArray, or } from 'drizzle-orm'
import type { AnyColumn, SQL } from 'drizzle-orm'
import type { GroupCondition, SimpleCondition, WhereCondition } from '../QueryBuilder'
import { normalizeConditionSequence } from '../where-conditions'

type DrizzleTableLike = Record<string, unknown>

/**
 * Resolves a Drizzle column reference from a table and field name.
 * @throws Error if the column does not exist on the table
 */
function resolveColumn(table: unknown, field: string): AnyColumn {
  const tableRecord = table as DrizzleTableLike
  const column = tableRecord[field] as AnyColumn | undefined

  if (!column) {
    throw new Error(`DrizzleConditions: unknown column "${field}" on provided table.`)
  }

  return column
}

/**
 * Builds a Drizzle ORM condition from a single SimpleCondition.
 */
function buildSimpleCondition(table: unknown, condition: SimpleCondition): SQL | undefined {
  const column = resolveColumn(table, condition.field)

  switch (condition.operator) {
    case '=':
      if (condition.value === null) {
        return isNull(column)
      }
      return eq(column, condition.value)

    case '!=':
      if (condition.value === null) {
        return isNotNull(column)
      }
      return ne(column, condition.value)

    case '>':
      return gt(column, condition.value)

    case '<':
      return lt(column, condition.value)

    case '>=':
      return gte(column, condition.value)

    case '<=':
      return lte(column, condition.value)

    case 'like':
      return like(column, condition.value as string)

    case 'in':
      return inArray(column, condition.value as unknown[])

    case 'not in':
      return notInArray(column, condition.value as unknown[])

    case 'is null':
      return isNull(column)

    case 'is not null':
      return isNotNull(column)

    default:
      throw new Error(`DrizzleConditions: unsupported operator "${condition.operator as string}".`)
  }
}

/**
 * Builds a Drizzle ORM condition from a GroupCondition.
 */
function buildGroupCondition(table: unknown, group: GroupCondition): SQL | undefined {
  const parts = group.conditions
    .map((c) => buildSingleCondition(table, c))
    .filter((c): c is SQL => c !== undefined)

  if (parts.length === 0) {
    return undefined
  }

  if (parts.length === 1) {
    return parts[0]
  }

  if (group.boolean === 'or') {
    return or(...parts)
  }

  return and(...parts)
}

/**
 * Builds a Drizzle ORM condition from any WhereCondition.
 */
function buildSingleCondition(table: unknown, condition: WhereCondition): SQL | undefined {
  if (condition.type === 'simple') {
    return buildSimpleCondition(table, condition)
  }

  return buildGroupCondition(table, condition)
}

/**
 * Translates an array of QueryBuilder WhereConditions into a single
 * Drizzle ORM condition expression.
 *
 * The list's sequential semantics — top-level conditions AND together,
 * an OR group folds everything before it into the OR, so
 *   .where('a', 1).where('b', 2).orWhere('c', 3)
 * produces `(a = 1 AND b = 2) OR (c = 3)` — are applied by
 * `normalizeConditionSequence` (shared with QueryBuilder's grouping
 * callbacks), leaving only a flat-join tree to render here.
 *
 * @param table - The Drizzle table object
 * @param conditions - Array of WhereCondition objects from QueryBuilder
 * @returns A Drizzle SQL condition or undefined if no conditions
 */
export function buildDrizzleConditions(table: unknown, conditions: WhereCondition[]): SQL | undefined {
  const normalized = normalizeConditionSequence(conditions)
  return normalized ? buildSingleCondition(table, normalized) : undefined
}
