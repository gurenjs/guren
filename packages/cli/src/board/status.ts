/**
 * `guren board:status` (RFC 0041 §3): per note, whether its link names an element the application
 * has (`present`), one a plan adds (`planned`), or neither (`missing`). Advisory: a board carries
 * no authority, so nothing here fails a run. The application is read as `plan:status` reads it,
 * with detail, since the side-effect classes are part of the detail.
 */

import { discoverPlanFiles } from '../plan-check'
import { readPlanFile } from '../plan-render'
import { isUnreadable, type PlanAppName, type PlanAppState, type PlanAppUnreadable } from '../plan/app-state'
import { readOpenPlan } from '../plan/open-plan'
import type { PlanChange, PlanDraft } from '../plan/schema'
import { toPosixRelative } from '../discovery'
import { boardFile, compareIds, type Board, type BoardLink, type BoardNote } from './schema'
import { readBoard } from './store'

/** Bumped when a field of {@link BoardStatusReport} changes meaning or goes away; additions do not bump it. */
export const BOARD_STATUS_REPORT_VERSION = 1

export const BOARD_NOTE_STATES = ['present', 'planned', 'missing', 'unknown', 'unlinked'] as const
export type BoardNoteState = (typeof BOARD_NOTE_STATES)[number]

export interface BoardNoteStatus {
  id: string
  kind: BoardNote['kind']
  text: string
  section?: string
  link?: BoardLink
  state: BoardNoteState
  /** The plans that add the element, app-relative; only on `planned`. */
  plannedIn?: string[]
  /** Why the application could not say; only on `unknown`. */
  reason?: string
}

export interface BoardStatusPlan {
  file: string
  /** `given` is the `--plan` file, read whether or not it is approved; `open` an approved plan not closed. */
  source: 'given' | 'open'
}

export interface BoardStatusReport {
  reportVersion: typeof BOARD_STATUS_REPORT_VERSION
  board: { slug: string; file: string; title: string }
  plans: BoardStatusPlan[]
  /** Plans and plan directories that would not read, so a link they add reads `missing`. */
  unreadPlans: Array<{ file: string; reason: string }>
  notes: BoardNoteStatus[]
  /** A note no element answers: a `missing` link, or no link on a note of a kind an element can stand for. */
  leadsNowhere: string[]
}

/** A question becomes a plan question and an actor is context: no link kind names either. */
const UNLINKABLE_KINDS: ReadonlySet<BoardNote['kind']> = new Set(['question', 'actor'])

type Scope = string | null

interface Named {
  name: string
  module: Scope
}

/** A route and a page are named across modules: neither a route name nor a page path is per root. */
const UNSCOPED_KINDS: ReadonlySet<BoardLink['kind']> = new Set(['route', 'page'])

function sameElement(link: BoardLink, entry: Named): boolean {
  return entry.name === link.name && (UNSCOPED_KINDS.has(link.kind) || entry.module === (link.module ?? null))
}

const ADDS: ReadonlySet<PlanChange['kind']> = new Set(['add', 'rename'])

/** The elements of `kind` the plan adds or renames to their name, the only ones it makes `planned`. */
export function planAdds(plan: PlanDraft, kind: BoardLink['kind']): Named[] {
  const adds = <T extends { change: PlanChange; module?: string }>(elements: readonly T[], nameOf: (element: T) => string): Named[] =>
    elements.filter((element) => ADDS.has(element.change.kind)).map((element) => ({ name: nameOf(element), module: element.module ?? null }))
  switch (kind) {
    case 'model':
      return adds(plan.models, (model) => model.name)
    case 'route':
      return adds(plan.routes, (route) => route.name)
    case 'page':
      return adds(plan.views, (view) => view.page)
    case 'action':
      return plan.controllers.flatMap((controller) =>
        controller.actions
          .filter((action) => ADDS.has(action.change.kind) || controller.change.kind === 'rename')
          .map((action) => ({ name: `${controller.className}.${action.name}`, module: controller.module ?? null })),
      )
    default:
      return adds(
        plan.sideEffects.filter((effect) => effect.kind === kind),
        (effect) => effect.name,
      )
  }
}

/** What the application has of a kind; `unread` says why an absence from `names` proves nothing. */
export interface AppSection {
  names: Named[]
  unread?: string
}

/** What the application has of `kind`, as `loadPlanAppState({ detail: true })` read it. */
export function appElements(app: PlanAppState | PlanAppUnreadable, kind: BoardLink['kind']): AppSection {
  if ('unreadable' in app) return { names: [], unread: app.unreadable }
  const of = (section: PlanAppName[] | PlanAppUnreadable): AppSection => (isUnreadable(section) ? { names: [], unread: section.unreadable } : { names: section })
  switch (kind) {
    case 'model':
      return of(app.models)
    case 'action':
      return of(app.actions)
    case 'page':
      return of(app.pages)
    case 'route': {
      if (isUnreadable(app.routes)) return { names: [], unread: app.routes.unreadable }
      const names = app.routes.flatMap((route) => (route.name === undefined ? [] : [{ name: route.name, module: null }]))
      // A module whose routes did not load leaves the list a lower bound.
      return app.detail?.routesIncomplete ? { names, unread: app.detail.routesIncomplete } : { names }
    }
    default: {
      const section = app.detail?.sideEffects[kind]
      if (section === undefined) return { names: [], unread: 'the application was read without its side-effect classes' }
      return isUnreadable(section) ? { names: [], unread: section.unreadable } : { names: section.map((effect) => ({ name: effect.className, module: effect.module })) }
    }
  }
}

export interface LoadedPlan {
  file: string
  plan: PlanDraft
}

/** Pure: the report from the board, the plans and the application as read. */
export function judgeBoardStatus(input: {
  slug: string
  board: Board
  plans: Array<LoadedPlan & { source: BoardStatusPlan['source'] }>
  unreadPlans: BoardStatusReport['unreadPlans']
  app: PlanAppState | PlanAppUnreadable
}): BoardStatusReport {
  const unreadPlans = input.unreadPlans.length === 0 ? undefined : `${input.unreadPlans.map((entry) => entry.file).join(', ')} could not be read`
  const notes = [...input.board.notes].sort((a, b) => compareIds(a.id, b.id)).map((note): BoardNoteStatus => {
    const base = { id: note.id, kind: note.kind, text: note.text, ...(note.section === undefined ? {} : { section: note.section }) }
    const link = note.link
    if (!link) return { ...base, state: 'unlinked' }
    const app = appElements(input.app, link.kind)
    if (app.names.some((entry) => sameElement(link, entry))) return { ...base, link, state: 'present' }
    const plannedIn = input.plans.filter(({ plan }) => planAdds(plan, link.kind).some((entry) => sameElement(link, entry))).map(({ file }) => file)
    if (plannedIn.length > 0) return { ...base, link, state: 'planned', plannedIn }
    if (app.unread !== undefined) return { ...base, link, state: 'unknown', reason: app.unread }
    // A plan that did not read may be the one adding it, so its absence proves nothing.
    if (unreadPlans) return { ...base, link, state: 'unknown', reason: unreadPlans }
    return { ...base, link, state: 'missing' }
  })
  return {
    reportVersion: BOARD_STATUS_REPORT_VERSION,
    board: { slug: input.slug, file: boardFile(input.slug), title: input.board.title },
    plans: input.plans.map(({ file, source }) => ({ file, source })),
    unreadPlans: input.unreadPlans,
    notes,
    leadsNowhere: notes.filter((note) => note.state === 'missing' || (note.state === 'unlinked' && !UNLINKABLE_KINDS.has(note.kind))).map((note) => note.id),
  }
}

export interface BoardStatusOptions {
  /** A plan file to judge against, app-relative or absolute, read whether or not it is approved. */
  plan?: string
  app: () => Promise<PlanAppState>
}

/** The open plans, by `check --plan`'s discovery rule and `readOpenPlan()`, each that would not read reported. */
async function openPlans(appRoot: string): Promise<{ plans: LoadedPlan[]; unread: BoardStatusReport['unreadPlans'] }> {
  const discovery = await discoverPlanFiles(appRoot)
  const unread = discovery.unreadable.map(({ dir, reason }) => ({ file: toPosixRelative(appRoot, dir), reason }))
  const plans: LoadedPlan[] = []
  for (const path of discovery.files) {
    const reading = await readOpenPlan(appRoot, path)
    if (reading.kind === 'open') plans.push({ file: reading.plan.file, plan: reading.plan.plan })
    else if (reading.kind !== 'skipped') unread.push({ file: toPosixRelative(appRoot, path), reason: reading.reason })
  }
  return { plans, unread }
}

export async function boardStatus(appRoot: string, slug: string, options: BoardStatusOptions): Promise<BoardStatusReport> {
  const board = await readBoard(appRoot, slug)
  let plans: Array<LoadedPlan & { source: BoardStatusPlan['source'] }>
  let unreadPlans: BoardStatusReport['unreadPlans']
  if (options.plan !== undefined) {
    const { path, plan } = await readPlanFile(options.plan, appRoot)
    plans = [{ file: toPosixRelative(appRoot, path), plan, source: 'given' }]
    unreadPlans = []
  } else {
    const open = await openPlans(appRoot)
    plans = open.plans.map((plan) => ({ ...plan, source: 'open' }))
    unreadPlans = open.unread
  }
  // A throw is a reading that failed, not a failed run: every link then reads `unknown` or `planned`.
  const app = await options.app().catch((error: unknown): PlanAppUnreadable => ({ unreadable: `the application could not be read: ${(error as Error).message}` }))
  return judgeBoardStatus({ slug, board, plans, unreadPlans, app })
}

function linkLabel(link: BoardLink): string {
  return `= ${link.kind} ${link.name}${link.module === undefined ? '' : ` (${link.module})`}`
}

export function formatBoardStatus(report: BoardStatusReport): string {
  const lines = [`Board: ${report.board.title}  (${report.board.file})`]
  lines.push(report.plans.length === 0 ? 'Plans: none open' : `Plans: ${report.plans.map((plan) => `${plan.file} (${plan.source})`).join(', ')}`)
  for (const unread of report.unreadPlans) lines.push(`  not read: ${unread.file}: ${unread.reason}`)

  const linked = report.notes.filter((note) => note.link !== undefined)
  lines.push('', linked.length === 0 ? 'No note has a link yet.' : 'Linked notes:')
  const width = Math.max(...BOARD_NOTE_STATES.map((state) => state.length))
  for (const note of linked) {
    const where = note.state === 'planned' ? `  (${note.plannedIn!.join(', ')})` : note.state === 'unknown' ? `  (${note.reason})` : ''
    lines.push(`  ${note.state.padEnd(width)}  [${note.kind} ${note.id}] ${note.text}  ${linkLabel(note.link!)}${where}`)
  }

  const byId = new Map(report.notes.map((note) => [note.id, note]))
  lines.push('', report.leadsNowhere.length === 0 ? 'Every note leads somewhere.' : `Lead nowhere (${report.leadsNowhere.length}):`)
  for (const id of report.leadsNowhere) {
    const note = byId.get(id)!
    lines.push(`  [${note.kind} ${note.id}] ${note.text}  ${note.link ? `${linkLabel(note.link)} (missing)` : '(no link)'}`)
  }
  return lines.join('\n')
}
