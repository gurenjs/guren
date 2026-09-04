import type { WhereCondition } from './QueryBuilder'

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

function combine(boolean: 'and' | 'or', parts: WhereCondition[]): WhereCondition | null {
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!
  return { type: 'group', boolean, conditions: [...parts] }
}
