/**
 * `guren plan:render` (RFC 0030 §3): validate a plan document and write it as one
 * self-contained HTML file. The page is written beside the plan, never into `docs/`:
 * it is a review artifact, not project knowledge, and nothing regenerates it.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import type { z } from 'zod'

import { CliError } from './cli-error'
import type { PlanAppState } from './plan/app-state'
import { hasBaseline, renderPlanHtml } from './plan/render'
import { validatePlan, type PlanCheckResult } from './plan/validate'
import { writeFileSafe } from './utils'
import { PlanDraftSchema, PlanSchema, type Plan, type PlanDraft } from './plan/schema'

export interface RenderPlanFileOptions {
  /**
   * The application the plan is checked against. Required: a page rendered without
   * the checks shows an empty "needs attention" block, which reads as a clean plan.
   */
  app: PlanAppState
  /** Where to write. Relative paths resolve against the working directory, as a shell argument reads. */
  output?: string
  /** Resolves the plan and the output path. The application root is {@link RenderPlanFileOptions.app}'s. */
  cwd?: string
}

export interface RenderedPlanFile {
  path: string
  /** Every §2 finding, as the page received them. */
  checks: PlanCheckResult[]
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  ${issue.path.length ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('\n')
}

/**
 * Either form renders. A document carrying a `baseline` is held to `PlanSchema`, so
 * that a malformed baseline is reported rather than silently dropping the plan's
 * identity; anything else is a draft.
 */
export function parsePlanDocument(document: unknown): PlanDraft | Plan {
  const parsed = (hasBaseline(document) ? PlanSchema : PlanDraftSchema).safeParse(document)
  if (parsed.success) return parsed.data
  throw new CliError(`The plan does not match the plan schema:\n${formatIssues(parsed.error)}`)
}

/** Whether two paths reach one file. A target that does not exist is not the plan, which does. */
async function isSameFile(target: string, plan: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([stat(target), stat(plan)])
    return a.dev === b.dev && a.ino === b.ino
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function planOutputPath(planPath: string): string {
  return planPath.endsWith('.json') ? `${planPath.slice(0, -'.json'.length)}.html` : `${planPath}.html`
}

export async function renderPlanFile(planPath: string, options: RenderPlanFileOptions): Promise<RenderedPlanFile> {
  const cwd = options.cwd ?? process.cwd()
  const absolutePlan = resolve(cwd, planPath)

  let raw: string
  try {
    raw = await readFile(absolutePlan, 'utf8')
  } catch (error) {
    throw new CliError(`Cannot read the plan at ${absolutePlan}: ${(error as Error).message}`)
  }

  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (error) {
    throw new CliError(`${absolutePlan} is not valid JSON: ${(error as Error).message}`)
  }

  const plan = parsePlanDocument(document)
  // RFC 0030 §3: a failing check is pinned to the top of the page, never a reason to
  // render nothing. The page is where someone reads what is wrong with the plan.
  const checks = validatePlan(plan, options.app)
  const html = renderPlanHtml({ plan, checks, planFile: basename(absolutePlan) })
  const target = options.output ? resolve(cwd, options.output) : planOutputPath(absolutePlan)

  // The plan is the input every later step reads, and this command keeps no copy of it,
  // so an `-o` that lands on it would end the work rather than render it. Compared by
  // identity rather than by path: a case-insensitive filesystem, a symlink and a hard
  // link all reach one file under two names.
  if (await isSameFile(target, absolutePlan)) {
    throw new CliError(`Refusing to write the page over the plan itself at ${target}. Choose another -o path.`)
  }

  // The package's own writer: it creates the directory, so `-o build/plan.html` works
  // before `build/` exists. Always `force`, since re-rendering a plan is the normal case.
  try {
    await writeFileSafe(target, html, { force: true })
  } catch (error) {
    // A path the user chose, answered with the path rather than with a stack trace.
    if (error instanceof CliError) throw error
    throw new CliError(`Cannot write the page to ${target}: ${(error as Error).message}`)
  }
  return { path: target, checks }
}
