/**
 * `guren plan:close` (RFC 0030 §7): end an approved plan whose every element is verified or
 * waived, judged by `planStatusFile()`, the one reading `plan:status` prints. It writes the
 * plan's doc node and the entity documents' marker-fenced blocks, and deletes nothing: under
 * the file store the plan, its approvals and its decision log stay committed as the archive.
 * It offers `make:adr` for each waiver rather than writing one, since an ADR is a person's text.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import { CliError } from './cli-error'
import { toPosixRelative } from './discovery'
import { parseDocFrontmatter } from './docs-frontmatter'
import { planStatusFile } from './plan-status'
import { readPlanFile } from './plan-render'
import type { PlanAppState } from './plan/app-state'
import { readPlanApprovals, requireReadableApprovals, type PlanApproval } from './plan/approvals'
import { writeFileAtomic } from './plan/beside'
import { renderEntityDoc, renderPlanDoc, touchedModels, type PlanCloseContext } from './plan/close-docs'
import type { PlanWaiver } from './plan/decisions'
import { planHash } from './plan/identity'
import { hasBaseline } from './plan/render'
import type { PlanModel } from './plan/schema'
import { planSlug } from './plan/state'
import { readPlanWaivers } from './plan/verification'

export const PLAN_CLOSE_REPORT_VERSION = 1

export type PlanCloseWriteAction = 'create' | 'update' | 'unchanged'

export interface PlanCloseWrite {
  /** Relative to the application root, POSIX separators. */
  path: string
  action: PlanCloseWriteAction
  /** The file as written, or as it would be under `--dry-run`. */
  content: string
}

/** What `--json` prints. */
export interface PlanCloseReport {
  reportVersion: typeof PLAN_CLOSE_REPORT_VERSION
  plan: { file: string; title: string; hash: string }
  approval: PlanApproval
  dryRun: boolean
  writes: PlanCloseWrite[]
  /** The waivers the plan closed with: each is a deviation `make:adr` is offered for. */
  waivers: PlanWaiver[]
  adrCommands: string[]
  /** What the run could not do for a document, which a person may want to fix by hand. */
  notes: string[]
}

export interface PlanCloseFileOptions {
  /** Loaded with `detail`, as `plan:status` loads it. Resolved only once the plan is approved. */
  app: PlanAppState | (() => Promise<PlanAppState>)
  appRoot: string
  cwd?: string
  dryRun?: boolean
}

/** A slug names the blocks inside HTML comments, so it may not carry what would end one or split the marker. */
const MARKER_SLUG = /^[A-Za-z0-9_.-]+$/u

/** `docs/plans/<slug>/plan.json` (the §9 layout) is named by its directory; any other plan by its file. */
function closeSlug(planPath: string): string {
  return basename(planPath) === 'plan.json' ? basename(dirname(planPath)) : planSlug(planPath)
}

function entityDocPath(model: PlanModel): string {
  return model.module ? `modules/${model.module}/docs/entities/${model.name}.md` : `docs/entities/${model.name}.md`
}

export async function planCloseFile(planPath: string, options: PlanCloseFileOptions): Promise<PlanCloseReport> {
  const { path, plan } = await readPlanFile(planPath, options.cwd)
  const appRoot = resolve(options.appRoot)
  if (!hasBaseline(plan)) {
    throw new CliError(`${path} is a draft: it was never approved, so there is nothing to close. Run guren plan:approve on it first.`)
  }
  const hash = planHash(plan)
  const approvals = requireReadableApprovals(await readPlanApprovals(path))
  const approval = approvals.approvals.find((candidate) => candidate.hash === hash)
  if (!approval) {
    throw new CliError(
      `${path} is not approved at its current hash ${hash}, so it is not closed: what was verified may not be what anyone agreed to. Run guren plan:approve on it.`,
    )
  }
  const slug = closeSlug(path)
  if (!MARKER_SLUG.test(slug)) {
    throw new CliError(`The plan's slug "${slug}" names the blocks it writes, and may hold only letters, digits, ".", "_" and "-". Rename the plan file.`)
  }

  const status = await planStatusFile(path, { app: options.app, appRoot, cwd: options.cwd })
  const verification = status.verification
  const blockers = status.elements
    .filter((element) => element.change !== 'existing' && element.state !== 'verified' && element.state !== 'waived')
    .map((element) => `  ${element.id}: ${element.state}${element.reason ? ` (${element.reason})` : ''}`)
  if (verification?.unreadable) blockers.push(`  verification records: ${verification.unreadable}`)
  if (verification?.decisionsUnreadable) blockers.push(`  decision log: ${verification.decisionsUnreadable}`)
  if (blockers.length > 0) {
    throw new CliError(
      `${path} is not closed: every element must be verified (guren plan:verify) or waived with a reason (guren plan:waive), and these are not:\n${blockers.join('\n')}`,
    )
  }

  const { waivers } = await readPlanWaivers(path, plan)
  const planFile = toPosixRelative(appRoot, path)
  const context: PlanCloseContext = {
    plan,
    hash,
    slug,
    approval,
    elements: status.elements,
    waivers,
    ...(planFile.startsWith('../') ? {} : { planFile }),
    planDocPath: `docs/plans/${slug}.md`,
    entityDocPath,
  }

  const notes: string[] = []
  const planned: Array<{ path: string; content: string }> = [{ path: context.planDocPath, content: renderPlanDoc(context) }]
  for (const model of touchedModels(plan)) {
    const docPath = entityDocPath(model)
    const existing = await readOptional(resolve(appRoot, docPath))
    if (existing !== undefined && !namesEntity(existing, model.name)) {
      notes.push(`${docPath} does not name ${model.name} in its frontmatter entities, so the docs graph does not link it to the entity. Add it by hand.`)
    }
    planned.push({ path: docPath, content: renderEntityDoc(existing, context, model) })
  }

  const writes: PlanCloseWrite[] = []
  for (const entry of planned) {
    const target = resolve(appRoot, entry.path)
    const before = await readOptional(target)
    const action: PlanCloseWriteAction = before === undefined ? 'create' : before === entry.content ? 'unchanged' : 'update'
    if (!options.dryRun && action !== 'unchanged') {
      await mkdir(dirname(target), { recursive: true })
      await writeFileAtomic(target, entry.content)
    }
    writes.push({ path: entry.path, action, content: entry.content })
  }

  const closedWith = status.elements.flatMap((element) => {
    const waiver = element.state === 'waived' ? waivers.get(element.id) : undefined
    return waiver ? [waiver] : []
  })
  return {
    reportVersion: PLAN_CLOSE_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash },
    approval,
    dryRun: options.dryRun === true,
    writes,
    waivers: closedWith,
    adrCommands: closedWith.map((waiver) => `guren make:adr ${JSON.stringify(`${plan.title}: ${waiver.elementId} waived`)}`),
    notes,
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Whether a document's frontmatter lists the entity, by the parser `scanDocs()` reads it with. */
function namesEntity(document: string, entity: string): boolean {
  const entities = parseDocFrontmatter(document)?.data.entities
  const list = typeof entities === 'string' ? [entities] : Array.isArray(entities) ? entities : []
  return list.some((entry) => typeof entry === 'string' && entry.toLowerCase() === entity.toLowerCase())
}

export function formatPlanClose(report: PlanCloseReport): string {
  const lines = [`${report.plan.title} (${report.plan.file})`, '']
  const verb: Record<PlanCloseWriteAction, string> = report.dryRun
    ? { create: 'would create', update: 'would update', unchanged: 'unchanged' }
    : { create: 'created', update: 'updated', unchanged: 'unchanged' }
  for (const write of report.writes) lines.push(`  ${verb[write.action].padEnd(12)}  ${write.path}`)
  if (report.dryRun) {
    for (const write of report.writes) {
      if (write.action !== 'unchanged') lines.push('', `--- ${write.path}`, write.content.trimEnd())
    }
  }
  for (const note of report.notes) lines.push('', note)
  if (report.adrCommands.length > 0) {
    lines.push('', 'The plan closed with waivers. Record the ones worth keeping as decisions:')
    for (const command of report.adrCommands) lines.push(`  ${command}`)
  }
  lines.push(
    '',
    report.dryRun
      ? 'Nothing was written (--dry-run).'
      : `Closed ${report.plan.hash}. The plan, its approvals and its decision log stay where they are, committed; docs/spec/ stays the description of record.`,
  )
  return lines.join('\n')
}
