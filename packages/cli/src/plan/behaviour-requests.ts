/**
 * Whether each acceptance behaviour's test still requests the route the behaviour names
 * (RFC 0030 §5), read from `test-requests.ts`'s per-case scan against the plan's own route.
 * Tamper detection, not proof: a request the file spells passes whether or not it runs.
 * A request the reader cannot resolve is never read as a miss; it is reported apart.
 */

import { join } from 'node:path'

import { ParseCache } from '../parse-cache'
import { mayReach, scanTestCaseRequests, testCoverage, type TestCaseScan, type TestRequestRoute, type UnresolvedReason } from '../test-requests'
import type { Plan, PlanDraft } from './schema'

export interface BehaviourRequestFindings {
  /** Behaviours whose tests request another route, or none. */
  misses: string[]
  /** Behaviours whose tests make a request, or hand the `TestApp` on, in a way this reader cannot resolve. */
  unreadable: string[]
}

/** The test files `plan:verify` selected: app-relative, and each id's carriers among them. */
export interface BehaviourTestSelection {
  files: readonly string[]
  carriers: ReadonlyMap<string, readonly string[]>
}

type BehaviourPlan = Pick<Plan | PlanDraft, 'tasks' | 'routes'>

const UNRESOLVED: Record<UnresolvedReason, string> = {
  dynamicPath: 'a path the file does not spell',
  partialSegment: 'a path segment mixing text with a runtime value',
  unknownReceiver: 'a request on what an imported helper returns',
  localReceiver: 'a request on what a function of the file returns with no `TestApp` return type: annotate it `TestApp` or `Promise<TestApp>`',
  routePattern: 'a route pattern this reader cannot compare',
  routeOrder: 'a route registered before it that may answer first',
}

function describeRoute(route: TestRequestRoute): string {
  return `${route.method} ${route.path}${route.toolName === undefined ? '' : ` or agent().call('${route.toolName}')`}`
}

/**
 * An id no file carries is left to the tests themselves, which report it pending. A whole
 * path segment filled at runtime reaches a constrained parameter here: whether the value
 * passes the constraint is the run's to find, as a 404.
 */
export function judgeBehaviourRequests(plan: BehaviourPlan, ids: readonly string[], scan: TestCaseScan, carriers: ReadonlyMap<string, readonly string[]>): BehaviourRequestFindings {
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
    const coverages = cases.map((entry) => testCoverage(entry, [route], { runtimeFillsConstraints: true }))
    if (coverages.some((coverage) => (coverage.byRoute.get(0)?.length ?? 0) > 0)) continue

    const unread = new Set<string>()
    cases.forEach((entry, index) => {
      for (const request of coverages[index]!.uncertainByRoute.get(0) ?? []) unread.add(`${request.file}:${request.line} ${request.text} (${UNRESOLVED[request.reason]})`)
      for (const request of entry.unresolved) if (mayReach(request, route)) unread.add(`${request.file}:${request.line} ${request.text} (${UNRESOLVED[request.reason]})`)
      for (const site of entry.handedOff) unread.add(`${site.file}:${site.line} hands the TestApp to ${site.text}`)
    })
    for (const file of files) {
      if (scan.unparsed.includes(file)) unread.add(`${file} does not parse`)
      for (const site of scan.opaqueTitles) if (site.file === file) unread.add(`${file}:${site.line} a test titled ${site.text}`)
    }
    const target = describeRoute(route)
    if (unread.size > 0) {
      findings.unreadable.push(`[${id}] cannot tell whether its test requests ${target}: ${[...unread].join('; ')}`)
      continue
    }
    const made = new Set([
      ...cases.map((entry) => `${entry.file}:${entry.line} requests ${entry.requests.map((request) => request.text).join(', ') || 'nothing'}`),
      ...(scan.bodiless.get(id) ?? []).map((site) => `${site.file}:${site.line} is a test with no body`),
    ])
    if (made.size === 0) findings.misses.push(`[${id}] is in no test or describe title in ${files.join(', ')}, so no test of it requests ${target}`)
    else findings.misses.push(`[${id}] no test carrying it requests ${target}: ${[...made].join('; ')}`)
  }
  return findings
}

/** Reads the selected files per test case and judges each of `ids`. */
export async function readBehaviourRequests(root: string, plan: BehaviourPlan, ids: readonly string[], selection: BehaviourTestSelection): Promise<BehaviourRequestFindings> {
  const wanted = new Set(ids)
  const scan = await scanTestCaseRequests(root, selection.files.map((file) => join(root, file)), new ParseCache(), (token) => wanted.has(token))
  return judgeBehaviourRequests(plan, ids, scan, selection.carriers)
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
