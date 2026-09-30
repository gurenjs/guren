import { createHash } from 'node:crypto'
import { z } from 'zod'

export const GRAPH_KINDS = ['route', 'controller', 'model', 'page', 'middleware', 'validator', 'policy', 'test'] as const
export const GRAPH_RELATIONS = ['handles', 'binds', 'renders', 'usesMiddleware', 'validates', 'authorizes', 'tests'] as const
const reason = z.object({ code: z.string(), message: z.string(), file: z.string().optional() })
const evidence = z.object({ kind: z.enum(['registered', 'static']), source: z.string(), file: z.string().optional(), line: z.number().int().positive().optional() })
export const graphCoverageSchema = z.object({ status: z.enum(['complete', 'partial', 'unavailable']), reasons: z.array(reason) })
const node = z.object({
  id: z.string(), kind: z.enum(GRAPH_KINDS), label: z.string(), module: z.string().nullable(),
  file: z.string().optional(), evidence: z.array(evidence),
  route: z.object({ method: z.string(), path: z.string(), name: z.string().optional(), action: z.string().optional(), order: z.number().int().nonnegative() }).optional(),
})
const edge = z.object({ from: z.string(), to: z.string(), relation: z.enum(GRAPH_RELATIONS), evidence: z.array(evidence) })
const unresolved = z.object({ from: z.string().optional(), relation: z.string().optional(), target: z.string(), reason: z.string() })
export const applicationGraphSchema = z.object({
  schemaVersion: z.literal(1),
  snapshot: z.object({ id: z.string(), capturedAt: z.string(), consistency: z.enum(['stable', 'changed']) }),
  coverage: z.record(z.string(), graphCoverageSchema),
  nodes: z.array(node), edges: z.array(edge), unresolved: z.array(unresolved),
})
export const graphResultSchema = z.union([applicationGraphSchema, z.object({
  schemaVersion: z.literal(1), error: z.object({ code: z.string(), message: z.string() }),
})])
export type GurenApplicationGraph = z.infer<typeof applicationGraphSchema>
export type GraphResult = z.infer<typeof graphResultSchema>
export type GraphNode = GurenApplicationGraph['nodes'][number]
export type GraphEvidence = z.infer<typeof evidence>
export type GraphCoverage = z.infer<typeof graphCoverageSchema>
export type ApplicationGraphInputs = Pick<GurenApplicationGraph, 'nodes' | 'edges' | 'unresolved' | 'coverage'> & {
  fingerprints?: Record<string, string>
  capturedAt: string
  changed?: boolean
}

export function graphId(...parts: Array<string | number | null>): string {
  return JSON.stringify(parts)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function graphDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function ordered<T>(values: T[]): T[] {
  return [...values].sort((a, b) => {
    const left = canonical(a)
    const right = canonical(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

export function buildApplicationGraph(input: ApplicationGraphInputs): GurenApplicationGraph {
  const coverage = { ...input.coverage }
  const nodes = ordered(input.nodes.map((entry) => ({ ...entry, evidence: ordered(entry.evidence) })))
  const ids = new Set(nodes.map((entry) => entry.id))
  if (ids.size !== nodes.length) throw new Error('Duplicate application graph node ID.')
  const unresolved = [...input.unresolved]
  const edges = input.edges.flatMap((entry) => {
    if (ids.has(entry.from) && ids.has(entry.to)) return [{ ...entry, evidence: ordered(entry.evidence) }]
    unresolved.push({ from: ids.has(entry.from) ? entry.from : undefined, relation: entry.relation, target: entry.to, reason: 'An endpoint could not be resolved.' })
    const reasons = (coverage[entry.relation]?.reasons ?? []).filter((reason) => reason.code !== 'endpoint')
    coverage[entry.relation] = { status: 'partial', reasons: [...reasons, { code: 'endpoint', message: 'An edge endpoint could not be resolved.' }] }
    return []
  })
  // Filled after the edges, so a relation an edge was read for is never reported as having no reader.
  for (const key of [...GRAPH_KINDS, ...GRAPH_RELATIONS]) {
    coverage[key] ??= { status: 'unavailable', reasons: [{ code: 'unsupported', message: 'No reader for this section.' }] }
  }
  for (const [key, value] of Object.entries(coverage)) coverage[key] = { ...value, reasons: ordered(value.reasons) }
  const content = { coverage, nodes, edges: ordered(edges), unresolved: ordered(unresolved) }
  return {
    schemaVersion: 1,
    snapshot: { id: graphDigest({ ...content, fingerprints: input.fingerprints ?? {} }), capturedAt: input.capturedAt, consistency: input.changed ? 'changed' : 'stable' },
    ...content,
  }
}

export function isCompleteGraph(result: GraphResult): boolean {
  return 'snapshot' in result && result.snapshot.consistency === 'stable'
    && Object.values(result.coverage).every((entry) => entry.status === 'complete')
}
