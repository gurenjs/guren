import type { WhereCondition } from './QueryBuilder'

/**
 * True when the caller wrote filters and every one of them was `undefined`.
 * Such a criteria object renders no WHERE clause at all, so the query reaches
 * every row; an explicitly empty `{}` still means "no filter" and is false.
 */
export function everyFilterDropped(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false
  const values = Object.values(where as Record<string, unknown>)
  return values.length > 0 && values.every((value) => value === undefined)
}

/**
 * Folds a builder's condition list into one node, or null when it holds
 * nothing renderable. An OR group folds everything before it into the OR, so
 * `.where(a).where(b).orWhere(c)` reads `(a AND b) OR c`. The one
 * implementation of that fold: the Drizzle renderer applies it to the
 * top-level list, QueryBuilder to a grouping callback's, so they cannot drift.
 */
export function normalizeConditionSequence(conditions: WhereCondition[]): WhereCondition | null {
  let pending: WhereCondition[] = []

  for (const condition of conditions) {
    if (!(condition.type === 'group' && condition.boolean === 'or')) {
      pending.push(condition)
      continue
    }
    if (condition.conditions.length === 0) continue
    const andBlock = combine('and', pending)
    pending = [combine('or', andBlock ? [andBlock, ...condition.conditions] : condition.conditions)!]
  }

  return combine('and', pending)
}

/**
 * Folds a list and makes the result safe to splice into another list. An
 * or-group means two things by position: a parenthesized disjunction in member
 * position, an orWhere continuation at the head. Wrapping selects the first.
 */
export function groupConditionSequence(
  conditions: WhereCondition[],
  boolean: 'and' | 'or' = 'and',
): WhereCondition | null {
  const folded = normalizeConditionSequence(conditions)
  if (!folded) return null
  const needsWrap = boolean === 'or' || (folded.type === 'group' && folded.boolean === 'or')
  return needsWrap ? { type: 'group', boolean, conditions: [folded] } : folded
}

function combine(boolean: 'and' | 'or', parts: WhereCondition[]): WhereCondition | null {
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!
  return { type: 'group', boolean, conditions: [...parts] }
}
