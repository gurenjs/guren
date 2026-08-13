import type { WhereCondition } from './QueryBuilder'

/**
 * Fold a builder's sequential condition list into one condition node.
 *
 * A condition list has sequential semantics: an OR group folds everything
 * before it into the OR, so `.where(a).where(b).orWhere(c)` reads
 * `(a AND b) OR c`. Inside a GroupCondition, members are joined flatly
 * with the group's boolean. This is the one implementation of that fold —
 * the Drizzle renderer applies it to the top-level list before rendering,
 * and QueryBuilder applies it to a grouping callback's collected list, so
 * the two can never drift apart.
 *
 * Returns null when the list holds no renderable condition.
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
