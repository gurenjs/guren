import { describe, expect, test } from 'bun:test'

import { renderPlanHtml } from '../src/plan/render'
import { planDraftJsonSchema } from '../src/plan/schema'
import { openPlanPage } from './plan-page-dom'
import { RICH_CHECKS, richPlan } from './plan-page-rich'

type JsonSchema = {
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
}

/** Every property the schema lets a plan carry, as a path: `models[].columns[].references.onDelete`. */
function schemaPaths(schema: JsonSchema, path = '', found = new Set<string>()): Set<string> {
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const at = path === '' ? key : `${path}.${key}`
    found.add(at)
    schemaPaths(child, at, found)
  }
  if (schema.items) schemaPaths(schema.items, `${path}[]`, found)
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])]) schemaPaths(branch, path, found)
  return found
}

/** `value`, reporting the path of every property read off it, at any depth. */
function watched<T extends object>(value: T, path: string, reads: Set<string>, seen = new WeakMap<object, object>()): T {
  const known = seen.get(value)
  if (known) return known as T
  const proxy = new Proxy(value, {
    get(target, key, receiver) {
      const read: unknown = Reflect.get(target, key, receiver)
      if (typeof key !== 'string') return read
      const isIndex = Array.isArray(target) && /^\d+$/.test(key)
      if (Array.isArray(target) && !isIndex) return read
      const at = isIndex ? `${path}[]` : path === '' ? key : `${path}.${key}`
      // Present or not: the page asking for an optional property is the page reading it.
      reads.add(at)
      return typeof read === 'object' && read !== null ? watched(read, at, reads, seen) : read
    },
  })
  seen.set(value, proxy)
  return proxy
}

/**
 * What the page read off the plan while it drew `html`. A flow is drawn from its
 * layout, which carries the plan's own flow properties under their own names, so a
 * read of `data.flows` is recorded as a read of `flows`.
 */
function planReads(html: string, reads: Set<string>): void {
  openPlanPage(html, {
    json: {
      stringify: JSON.stringify,
      parse: (text) => {
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed !== 'object' || parsed === null || !('plan' in parsed)) return parsed
        const payload = parsed as { plan: object; flows: object }
        return { ...payload, plan: watched(payload.plan, '', reads), flows: watched(payload.flows, 'flows', reads) }
      },
    },
  })
}

// oxlint-disable-next-line typescript/no-explicit-any -- fixtures rewritten property by property
type Loose = any

/** `value` with every property called `name` rewritten, at any depth. */
function rewrite(value: Loose, name: string, to: (old: Loose) => Loose): Loose {
  if (Array.isArray(value)) return value.map((item) => rewrite(item, name, to))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === name ? to(child) : rewrite(child, name, to)]))
}

/**
 * The rich plan, then the same plan once per branch a single document cannot take
 * twice: a change is one kind, and a data migration says `reason` or `description`.
 */
function everyBranch(): Loose[] {
  const plan: Loose = structuredClone(richPlan())
  plan.models[0].columns.push({
    id: 'column.post.price',
    name: 'price',
    change: { kind: 'add' },
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: false,
    unique: false,
    index: false,
  })
  plan.flows = [
    {
      id: 'flow.comment',
      change: { kind: 'add' },
      title: 'Leaving a comment',
      description: 'From the form to the row.',
      nodes: [
        { id: 'page', label: 'The post page', kind: 'page', element: 'view.posts.show' },
        { id: 'store', label: 'Store the comment', kind: 'action' },
      ],
      edges: [{ from: 'page', to: 'store', label: 'submits', kind: 'async' }],
    },
  ]
  return [
    plan,
    rewrite(plan, 'change', () => ({ kind: 'rename', from: 'Before' })),
    rewrite(plan, 'change', () => ({ kind: 'drop', reason: 'Unused.' })),
    rewrite(plan, 'dataMigration', (old) =>
      old.kind === 'none' ? { kind: 'manual', description: 'By hand.' } : { kind: 'none', reason: 'Nothing moves.' },
    ),
  ]
}

/**
 * Properties the page has no reason to read, each with why. A property the schema
 * gains is in neither this list nor the page, and fails the test below until someone
 * decides which of the two it belongs in.
 */
const NOT_READ: Record<string, string> = {}

describe('the plan page against the plan schema', () => {
  const declared = schemaPaths(planDraftJsonSchema() as JsonSchema)
  const reads = new Set<string>()
  for (const plan of everyBranch()) planReads(renderPlanHtml({ plan, checks: RICH_CHECKS }), reads)

  test('should read every property a plan can carry, or say why it does not', () => {
    expect([...declared].filter((path) => !reads.has(path) && !Object.hasOwn(NOT_READ, path)).sort()).toEqual([])
  })

  test('should excuse no property the page does read, and none the schema lacks', () => {
    expect(Object.keys(NOT_READ).filter((path) => reads.has(path) || !declared.has(path))).toEqual([])
  })

  test('should walk the whole schema', () => {
    expect(declared.size).toBeGreaterThan(150)
    expect(declared.has('models[].columns[].references.onDelete')).toBe(true)
    expect(declared.has('tasks[].acceptance[].expect.database[].missing[].json')).toBe(true)
  })
})
