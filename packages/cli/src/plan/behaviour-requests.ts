/**
 * Whether each acceptance behaviour's test still requests the route the behaviour names
 * (RFC 0030 §5), read from `test-requests.ts`'s per-case scan against the plan's own route.
 * Tamper detection, not proof: a request the file spells passes whether or not it runs.
 * A request the reader cannot resolve is never read as a miss; it is reported apart.
 */

import { mayReach, testCoverage, type TestCaseScan, type TestRequestRoute, type UnresolvedReason } from '../test-requests'
import type { Plan, PlanDraft } from './schema'

export interface BehaviourRequestFindings {
  /** Behaviours whose tests request another route, or none. */
  misses: string[]
  /** Behaviours whose tests make a request, or hand the `TestApp` on, in a way this reader cannot resolve. */
  unreadable: string[]
}

const UNRESOLVED: Record<UnresolvedReason, string> = {
  dynamicPath: 'a path the file does not spell',
  partialSegment: 'a path segment mixing text with a runtime value',
  unknownReceiver: 'a request on what an imported helper returns',
  routePattern: 'a route pattern this reader cannot compare',
}

function describeRoute(route: TestRequestRoute): string {
  return `${route.method} ${route.path}${route.toolName === undefined ? '' : ` or agent().call('${route.toolName}')`}`
}

/**
 * `carriers` is each id's test files by bracketed token, the selection `plan:verify` runs:
 * an id no file carries is left to the tests themselves, which report it pending.
 */
export function judgeBehaviourRequests(
  plan: Pick<Plan | PlanDraft, 'tasks' | 'routes'>,
  ids: readonly string[],
  scan: TestCaseScan,
  carriers: ReadonlyMap<string, readonly string[]>,
): BehaviourRequestFindings {
  const findings: BehaviourRequestFindings = { misses: [], unreadable: [] }
  const behaviours = new Map(plan.tasks.flatMap((task) => task.acceptance.map((behaviour) => [behaviour.id, behaviour] as const)))
  for (const id of ids) {
    const files = carriers.get(id) ?? []
    const behaviour = behaviours.get(id)
    if (files.length === 0 || !behaviour) continue
    const planned = plan.routes.find((route) => route.id === behaviour.route)
    if (!planned) {
      findings.unreadable.push(`[${id}] names ${behaviour.route}, which is not a route of the plan`)
      continue
    }
    const route: TestRequestRoute = { method: planned.method, path: planned.path, ...(planned.agent ? { toolName: planned.agent.toolName } : {}) }
    const cases = scan.cases.get(id) ?? []
    const unread: string[] = []
    let reached = false
    for (const entry of cases) {
      const coverage = testCoverage(entry, [route])
      if ((coverage.byRoute.get(0)?.length ?? 0) > 0) reached = true
      for (const request of coverage.uncertainByRoute.get(0) ?? []) unread.push(`${request.file}:${request.line} ${request.text} (${UNRESOLVED.routePattern})`)
      for (const request of entry.unresolved) if (mayReach(request, route)) unread.push(`${request.file}:${request.line} ${request.text} (${UNRESOLVED[request.reason]})`)
      for (const site of entry.handedOff) unread.push(`${site.file}:${site.line} hands the TestApp to ${site.text}`)
    }
    if (reached) continue
    for (const file of files) {
      if (scan.unparsed.includes(file)) unread.push(`${file} does not parse`)
      for (const site of scan.opaqueTitles) if (site.file === file) unread.push(`${file}:${site.line} a test titled ${site.text}`)
    }
    const target = describeRoute(route)
    if (unread.length > 0) {
      findings.unreadable.push(`[${id}] cannot tell whether its test requests ${target}: ${unread.join('; ')}`)
    } else if (cases.length === 0) {
      findings.misses.push(`[${id}] is in no test or describe title in ${files.join(', ')}, so no test of it requests ${target}`)
    } else {
      const made = cases.map((entry) => `${entry.file}:${entry.line} requests ${entry.requests.map((request) => request.text).join(', ') || 'nothing'}`)
      findings.misses.push(`[${id}] no test carrying it requests ${target}: ${made.join('; ')}`)
    }
  }
  return findings
}

/** The command outcome a finding makes, or `undefined` when every behaviour's test requests its route. */
export function behaviourRequestFailure(findings: BehaviourRequestFindings): { reason: string; findings: string[] } | undefined {
  const all = [...findings.misses, ...findings.unreadable]
  if (all.length === 0) return undefined
  const reason = findings.misses.length > 0
    ? 'a behaviour\'s test does not request the route the behaviour names'
    : 'a behaviour\'s test requests its route in a way this check cannot read: spell the request in the test'
  return { reason, findings: all }
}
