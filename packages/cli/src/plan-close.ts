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
import { SAFE_MODULE_NAME_RE } from './utils'
import { frontmatterEntities } from './docs-index'
import { planStatusFile } from './plan-status'
import { readPlanFile } from './plan-render'
import type { PlanAppState } from './plan/app-state'
import { requirePlanApproval, type PlanApproval } from './plan/approvals'
import { writeFileAtomic } from './plan/beside'
import { entityDocPath, planDocPath, renderEntityDoc, renderPlanDoc, touchedModels, type PlanCloseContext } from './plan/close-docs'
import type { PlanWaiver } from './plan/decisions'
import { hasBaseline } from './plan/render'
import type { Plan, PlanDraft } from './plan/schema'
import { planSlug } from './plan/state'
import { awaitsVerification, type PlanElementState, type PlanElementStatus } from './plan/status'
import { derivePlanTasks, type PlanDerivedStep } from './plan/tasks'
import { behaviourReach, readPlanWaivers } from './plan/verification'

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
/** A model's class name becomes the file name written for it; a module name follows `safeModuleName()`'s rule. */
const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Single-quoted for a POSIX shell, so a title carrying `$`, a backtick or `"` is printed as text. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

export async function planCloseFile(planPath: string, options: PlanCloseFileOptions): Promise<PlanCloseReport> {
  const read = await readPlanFile(planPath, options.cwd)
  const { path, plan } = read
  const appRoot = resolve(options.appRoot)
  if (!hasBaseline(plan)) {
    throw new CliError(`${path} is a draft: it was never approved, so there is nothing to close. Run guren plan:approve on it first.`)
  }
  const approved = await requirePlanApproval(path, plan, 'it is not closed')
  const { hash, approval } = approved
  const slug = planSlug(path)
  if (!MARKER_SLUG.test(slug)) {
    throw new CliError(`The plan's slug "${slug}" names the blocks it writes, and may hold only letters, digits, ".", "_" and "-". Rename the plan file or its directory.`)
  }
  const models = touchedModels(plan)
  const unsafe = models.filter((model) => !CLASS_NAME.test(model.name) || (model.module !== undefined && !SAFE_MODULE_NAME_RE.test(model.module)))
  if (unsafe.length > 0) {
    throw new CliError(
      `${path} names models whose document path would not be a plain file under ${appRoot}, so nothing is written:\n${unsafe
        .map((model) => `  ${model.id}: name "${model.name}"${model.module === undefined ? '' : `, module "${model.module}"`}`)
        .join('\n')}`,
    )
  }

  const waiverRead = await readPlanWaivers(path, plan)
  const app = typeof options.app === 'function' ? await options.app() : options.app
  const status = await planStatusFile(path, { app, appRoot, read, waivers: waiverRead, approval: approved })
  const verification = status.verification
  const open = status.elements.filter((element) => element.change !== 'existing' && element.state !== 'verified' && element.state !== 'waived')
  const blockers: string[] = []
  if (open.length > 0) {
    const derivation = derivePlanTasks(plan, { apiOnly: app.apiOnly })
    blockers.push(...describeCloseBlockers(plan, derivation.tasks.flatMap((task) => task.steps), open, planPath))
  }
  if (verification?.unreadable) blockers.push(`  verification records: ${verification.unreadable}`)
  if (verification?.decisionsUnreadable) blockers.push(`  decision log: ${verification.decisionsUnreadable}`)
  if (blockers.length > 0) {
    throw new CliError(
      `${path} is not closed: every element must be verified or waived with a reason (guren plan:waive), and these are not, each with what holds it and what moves it:\n${blockers.join('\n')}`,
    )
  }

  const waived = new Map<string, PlanWaiver>()
  for (const element of status.elements) {
    const waiver = element.state === 'waived' ? waiverRead.waivers.get(element.id) : undefined
    if (waiver) waived.set(element.id, waiver)
  }
  const planFile = toPosixRelative(appRoot, path)
  const context: PlanCloseContext = {
    plan,
    hash,
    slug,
    approval,
    elements: status.elements,
    waived,
    ...(planFile.startsWith('../') ? {} : { planFile }),
  }

  const notes: string[] = []
  const problems: string[] = []
  const planned: Array<{ path: string; content: string; before: string | undefined }> = []
  planned.push({ path: planDocPath(slug), content: renderPlanDoc(context), before: await readOptional(resolve(appRoot, planDocPath(slug))) })
  for (const model of models) {
    const docPath = entityDocPath(model)
    const before = await readOptional(resolve(appRoot, docPath))
    if (before !== undefined && !frontmatterEntities(before).some((entry) => entry.toLowerCase() === model.name.toLowerCase())) {
      notes.push(`${docPath} does not name ${model.name} in its frontmatter entities, so the docs graph does not link it to the entity. Add it by hand.`)
    }
    const rendered = renderEntityDoc(before, context, model)
    if ('problems' in rendered) problems.push(...rendered.problems.map((problem) => `  ${docPath}, ${problem}`))
    else planned.push({ path: docPath, content: rendered.content, before })
  }
  if (problems.length > 0) {
    throw new CliError(
      `${path} is not closed: these documents carry guren:plan markers that cannot be rewritten safely, and nothing was written. Fix the markers by hand:\n${problems.join('\n')}`,
    )
  }

  const writes: PlanCloseWrite[] = []
  for (const entry of planned) {
    const target = resolve(appRoot, entry.path)
    const action: PlanCloseWriteAction = entry.before === undefined ? 'create' : entry.before === entry.content ? 'unchanged' : 'update'
    if (!options.dryRun && action !== 'unchanged') {
      await mkdir(dirname(target), { recursive: true })
      await writeFileAtomic(target, entry.content)
    }
    writes.push({ path: entry.path, action, content: entry.content })
  }

  const closedWith = [...waived.values()]
  return {
    reportVersion: PLAN_CLOSE_REPORT_VERSION,
    plan: { file: basename(path), title: plan.title, hash },
    approval,
    dryRun: options.dryRun === true,
    writes,
    waivers: closedWith,
    adrCommands: closedWith.map((waiver) => `guren make:adr ${shellQuote(`${plan.title}: ${waiver.elementId} waived`)}`),
    notes,
  }
}

interface BlockerContext {
  planArgument: string
  /** The step that verifies each element. */
  owners: Map<string, string>
  /** The steps whose behaviours reach each element, which is what lifts one none of whose planned properties matched. */
  carriers: Map<string, string[]>
}

/** The refusal's lines for `elements`, each with what holds it and the command that moves it. */
export function describeCloseBlockers(
  plan: PlanDraft | Plan,
  steps: readonly PlanDerivedStep[],
  elements: ReadonlyArray<PlanElementStatus<PlanElementState>>,
  planArgument: string,
): string[] {
  const context: BlockerContext = { planArgument, owners: new Map(), carriers: new Map() }
  for (const step of steps) {
    for (const id of step.elementIds) context.owners.set(id, step.id)
    if (step.kind === 'tests' || step.acceptanceIds.length === 0) continue
    for (const id of behaviourReach(plan, step.acceptanceIds)) {
      const carriers = context.carriers.get(id)
      if (carriers) carriers.push(step.id)
      else context.carriers.set(id, [step.id])
    }
  }
  return elements.map((element) => closeBlocker(element, context))
}

/** One refused element: what holds it, as `whatHoldsElement()` selects it (keep the two alike), and the command that moves it. */
function closeBlocker(element: PlanElementStatus<PlanElementState>, context: BlockerContext): string {
  const hold = element.hold
  const said = element.notes.filter((note) => note !== hold?.note).at(-1)
  const why = hold && hold.kind !== 'incomplete' ? hold.note : (element.reason ?? said)
  return `  ${element.id}: ${element.state}${why ? ` (${why.replace(/\.$/u, '')})` : ''}\n    ${closeRemedy(element, context)}`
}

/**
 * Mirrors `applyVerification()`'s holds: a run it would not count is never suggested, so an
 * element no step's behaviour reaches, or one with nothing to fingerprint, is sent to plan:waive.
 */
function closeRemedy(element: PlanElementStatus<PlanElementState>, context: BlockerContext): string {
  const owner = context.owners.get(element.id)
  const verify = (step: string): string => `\`bunx guren plan:verify ${context.planArgument} --step ${step}\``
  const waive = `\`bunx guren plan:waive ${context.planArgument} ${element.id} --reason "<why>"\``
  const orWaive = `; or waive it: ${waive}`
  if (owner === undefined) return `No step of the plan verifies it, so no plan:verify run lifts it: waive it with ${waive}`
  if (element.state === 'blocked') return `Fix what keeps it from being read, then run ${verify(owner)}${orWaive}`
  if (element.hold?.kind === 'expired') return `Run ${verify(owner)} again, since that run no longer holds${orWaive}`
  if (!awaitsVerification(element)) {
    const target = element.state === 'planned' ? 'Implement it' : `Change the code until plan:status reports it ${element.completesAt}`
    return `${target}, then run ${verify(owner)}${orWaive}`
  }
  const unmatched = element.change !== 'drop' && !element.properties.some((property) => property.verdict === 'match')
  const needsNoFiles = element.change === 'drop' || element.state === 'unjudged'
  const carriers = context.carriers.get(element.id) ?? []
  if (unmatched && carriers.length === 0) {
    return `No planned property of it matched and no step's behaviour reaches it, so no plan:verify run lifts it: waive it with ${waive}, or add a behaviour that reaches it and approve the plan again`
  }
  if (element.files.length === 0 && !needsNoFiles) return `plan:verify cannot fingerprint it, so no run lifts it: waive it with ${waive}`
  const runs = unmatched && !carriers.includes(owner) ? [carriers[0]!, owner] : [owner]
  return `Run ${runs.map(verify).join(', then ')}${orWaive}`
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
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
