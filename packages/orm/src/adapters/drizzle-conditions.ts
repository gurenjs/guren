import { and, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, notInArray, or } from 'drizzle-orm'
import type { AnyColumn, SQL } from 'drizzle-orm'
import type { GroupCondition, SimpleCondition, WhereCondition } from '../QueryBuilder'

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
 * The top-level conditions are joined with AND. OR conditions are
 * represented as GroupCondition nodes with `boolean: 'or'`.
 *
 * When an OR group is encountered, it creates:
 *   AND(previous_conditions, OR(previous_and_block, or_conditions))
 *
 * This matches the typical SQL builder behavior where:
 *   .where('a', 1).where('b', 2).orWhere('c', 3)
 * produces: (a = 1 AND b = 2) OR (c = 3)
 *
 * @param table - The Drizzle table object
 * @param conditions - Array of WhereCondition objects from QueryBuilder
 * @returns A Drizzle SQL condition or undefined if no conditions
 */
export function buildDrizzleConditions(table: unknown, conditions: WhereCondition[]): SQL | undefined {
  if (conditions.length === 0) {
    return undefined
  }

  // Separate AND conditions and OR groups
  // Strategy: collect AND conditions, when we hit an OR group,
  // wrap current AND block with the OR group.
  let currentAnd: SQL[] = []
  let result: SQL | undefined

  for (const condition of conditions) {
    if (condition.type === 'group' && condition.boolean === 'or') {
      // Build the OR group's conditions
      const orParts = condition.conditions
        .map((c) => buildSingleCondition(table, c))
        .filter((c): c is SQL => c !== undefined)

      if (orParts.length > 0) {
        // Combine current AND conditions into one block
        const andBlock = combineAnd(currentAnd, result)
        if (andBlock) {
          result = or(andBlock, ...orParts)
        } else {
          result = orParts.length === 1 ? orParts[0] : or(...orParts)
        }
        currentAnd = []
      }
    } else {
      const built = buildSingleCondition(table, condition)
      if (built) {
        currentAnd.push(built)
      }
    }
  }

  // Combine remaining AND conditions with result
  return combineAnd(currentAnd, result)
}

/**
 * Combines an array of AND conditions with an optional existing result.
 */
function combineAnd(andParts: SQL[], existing: SQL | undefined): SQL | undefined {
  const all: SQL[] = []

  if (existing) {
    all.push(existing)
  }

  all.push(...andParts)

  if (all.length === 0) {
    return undefined
  }

  if (all.length === 1) {
    return all[0]
  }

  return and(...all)
}
