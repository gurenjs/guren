import type { ModelQueryOptions, PlainObject } from './Model'
import type { EagerLoadConstraints } from './QueryBuilder'
import type { RelationDefinition } from './relation-definitions'
import { applyRelatedReadTransforms, resolveModelReference } from './relation-records'

export function groupRelationPaths(relationNames: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const path of relationNames) {
    const [head, ...rest] = path.split('.')
    const tails = groups.get(head) ?? []
    groups.set(head, tails)

    // A bare path contributes no tail, so `posts` alongside `posts.comments`
    // loads `posts` once. A trailing dot does contribute one — an empty tail
    // — so `posts.` still reaches the unknown-relation throw.
    if (rest.length > 0) {
      const tail = rest.join('.')
      if (!tails.includes(tail)) {
        tails.push(tail)
      }
    }
  }
  return groups
}

export async function loadRelationChildren({
  modelName, records, definition, head, tails, projected, currentPath, queryOptions, constraints,
}: {
  modelName: string
  records: PlainObject[]
  definition: RelationDefinition
  head: string
  tails: readonly string[]
  projected: boolean
  currentPath: string
  queryOptions?: ModelQueryOptions
  constraints?: EagerLoadConstraints
}): Promise<void> {
  if (tails.length > 0 && definition.type === 'morphTo') {
    throw new Error(
      `${modelName}: nested eager loading through morphTo relation "${head}" is not supported.`,
    )
  }

  // morphTo rows come from several models at once, so its own loader is what
  // applies each row's transforms.
  if (definition.type === 'morphTo') {
    return
  }

  // Deduplicated on identity: belongsTo and belongsToMany hand several
  // parents the same child object, which must not be transformed twice.
  const children: PlainObject[] = []
  const seen = new Set<PlainObject>()
  for (const record of records) {
    const value = record[head]
    const items = Array.isArray(value) ? value : value != null ? [value] : []
    for (const item of items) {
      if (item && typeof item === 'object' && !seen.has(item as PlainObject)) {
        seen.add(item as PlainObject)
        children.push(item as PlainObject)
      }
    }
  }

  if (children.length === 0) {
    return
  }

  const related = await resolveModelReference(definition.related)
  if (tails.length > 0) {
    await related.loadRelationsInto(children, tails, queryOptions, constraints, currentPath)
  }
  // After the recursion: the grandchildren were keyed on these rows' raw values.
  applyRelatedReadTransforms(related, children, projected)
}
