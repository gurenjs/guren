/**
 * Whether the person's decision on a plan would go through now (RFC 0030 §8, amended 2026-11-01):
 * `plan:approve`, `plan:close` or `plan:waive` run as a child with `--dry-run --json` under
 * `GUREN_PLAN_DRY_RUN=1`, so the writers refuse even if the flag were lost. Nothing here runs a
 * command that writes; the page copies the command for the person's own terminal.
 */

import { execFile } from 'node:child_process'

import { cliEntry } from './cli-entry'
import type { PlanDecision } from './dev-center-links'
import { locatePlan, NO_STORE, problem } from './dev-center-review'
import { PLAN_DRY_RUN_ENV } from './plan/beside'
import { listPlanElements } from './plan/schema'

const TIMEOUT_MS = 60_000
const OUTPUT_LIMIT = 4 * 1024 * 1024
const MESSAGE_LIMIT = 8 * 1024

export interface PlanReadiness {
  schemaVersion: 1
  decision: PlanDecision
  status: 'ready' | 'refused' | 'unavailable'
  checkedAt: string
  /** The arguments after `guren`; a waiver's `--reason` is the page's to add. */
  args: string[]
  element?: string
  /** `ready`: the command's `--json` report of what a real run would write. */
  report?: unknown
  /** `refused`: the CLI's refusal as it printed it. `unavailable`: why no answer came. */
  message?: string
}

interface ChildRun { exitCode: number | null; stdout: string; stderr: string; failed?: string }

export type ReadinessRunner = (argv: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<ChildRun>

export const runReadinessChild: ReadinessRunner = (argv, cwd, env) =>
  new Promise((resolve) => {
    execFile(process.execPath, [cliEntry(), ...argv], { cwd, env, timeout: TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT }, (error, stdout, stderr) => {
      if (!error) return resolve({ exitCode: 0, stdout, stderr })
      const failure = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null }
      if (failure.killed || failure.signal) return resolve({ exitCode: null, stdout, stderr, failed: 'The check took too long or was stopped.' })
      if (typeof failure.code !== 'number') return resolve({ exitCode: null, stdout, stderr, failed: 'The check could not start or its output was too large.' })
      resolve({ exitCode: failure.code, stdout, stderr })
    })
  })

/** consola prints a refusal as ` ERROR  <message>`; the level is the CLI's, not the message's. */
function refusalText(stderr: string): string {
  const text = stderr.replace(/^\s*ERROR\s+/u, '').trim()
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)}…` : text
}

export async function planReadiness(
  appRoot: string,
  slug: string,
  decision: PlanDecision,
  element: string | undefined,
  run: ReadinessRunner = runReadinessChild,
  now: () => Date = () => new Date(),
): Promise<PlanReadiness> {
  const located = await locatePlan(appRoot, slug)
  if (decision === 'waive') {
    // Matched against the plan's own ids before any child starts, so nothing the request sends reaches argv unread.
    if (element === undefined || !listPlanElements(located.plan).some((declared) => declared.id === element)) {
      throw problem(400, 'element', 'Name one element the plan declares.')
    }
  }
  // A root plan file may start with `-`, which citty and a shell would read as a flag.
  const file = located.file.startsWith('-') ? `./${located.file}` : located.file
  const args = [`plan:${decision}`, file, ...(decision === 'waive' ? [element!] : [])]
  const env = { ...process.env, [PLAN_DRY_RUN_ENV]: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
  // The child runs in the app root, so the plan is named as the person's terminal names it, in a refusal too.
  const child = await run([...args, '--dry-run', '--json', '--app', appRoot], appRoot, env)
  const head = { schemaVersion: 1 as const, decision, checkedAt: now().toISOString(), args, ...(decision === 'waive' ? { element } : {}) }
  if (child.failed) return { ...head, status: 'unavailable', message: child.failed }
  if (child.exitCode === 0) {
    try {
      const report = JSON.parse(child.stdout) as { dryRun?: unknown }
      if (report.dryRun === true) return { ...head, status: 'ready', report }
    } catch {
      // Falls through: output that is not the dry run's report is never read as ready.
    }
    return { ...head, status: 'unavailable', message: 'The check did not print a dry-run report.' }
  }
  if (child.exitCode === 1 && child.stderr.trim()) return { ...head, status: 'refused', message: refusalText(child.stderr) }
  return { ...head, status: 'unavailable', message: `The check exited with ${child.exitCode} and said nothing.` }
}

export async function handleReadinessRequest(appRoot: string, request: Request, route: { slug: string; decision: PlanDecision }, run?: ReadinessRunner): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { ...NO_STORE, Allow: 'GET' } })
  const element = new URL(request.url).searchParams.get('element') ?? undefined
  try {
    return Response.json(await planReadiness(appRoot, route.slug, route.decision, element, run), { headers: NO_STORE })
  } catch (error) {
    if (error instanceof Response) return error
    return problem(503, 'read-failed', 'The plan could not be read.')
  }
}
