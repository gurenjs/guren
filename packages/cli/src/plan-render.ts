/**
 * `guren plan:render` (RFC 0030 §3): validate a plan document and write it as one
 * self-contained HTML file. The page is written beside the plan, never into `docs/`:
 * it is a review artifact, not project knowledge, and nothing regenerates it.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import type { z } from 'zod'

import { CliError } from './cli-error'
import { renderPlanHtml, type PlanCheckResult } from './plan/render'
import { findDuplicatePlanIds, PlanDraftSchema, PlanSchema, type Plan, type PlanDraft } from './plan/schema'

export interface RenderPlanFileOptions {
  /** Where to write. Relative paths resolve against the working directory, as a shell argument reads. */
  output?: string
  cwd?: string
  checks?: readonly PlanCheckResult[]
}

export interface RenderedPlanFile {
  path: string
  /** Ids declared twice: their anchors collide, so the page links to whichever came first. */
  duplicateIds: string[]
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
  const hasBaseline = typeof document === 'object' && document !== null && 'baseline' in document
  const schema = hasBaseline ? PlanSchema : PlanDraftSchema
  const parsed = schema.safeParse(document)
  if (parsed.success) return parsed.data
  throw new CliError(`The plan does not match the plan schema:\n${formatIssues(parsed.error)}`)
}

export function planOutputPath(planPath: string): string {
  return planPath.endsWith('.json') ? `${planPath.slice(0, -'.json'.length)}.html` : `${planPath}.html`
}

export async function renderPlanFile(planPath: string, options: RenderPlanFileOptions = {}): Promise<RenderedPlanFile> {
  const cwd = options.cwd ?? process.cwd()
  const absolutePlan = isAbsolute(planPath) ? planPath : resolve(cwd, planPath)

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
  const html = renderPlanHtml({ plan, checks: options.checks })
  const target = options.output
    ? isAbsolute(options.output)
      ? options.output
      : resolve(cwd, options.output)
    : planOutputPath(absolutePlan)

  await writeFile(target, html, 'utf8')
  return { path: target, duplicateIds: findDuplicatePlanIds(plan) }
}
