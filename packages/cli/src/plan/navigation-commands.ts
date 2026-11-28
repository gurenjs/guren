/**
 * The commands `plan:next` names for a step's navigation entries (RFC 0040 §5, "One writer"): `guren nav:add`
 * and `nav:remove`, so the entries go through the writer rather than an edit by hand. What the commands cannot
 * say (an alter, a `where`, a module's model in a `can`, an entry already there that shows otherwise) is named as
 * an edit instead.
 */

import type { NavigationFileEntry } from '../navigation-file'
import { navigationRouteName } from './app-targets'
import type { PlanDraft, PlanNavigation } from './schema'

export interface PlanNavigationWork {
  id: string
  /** A command to run as printed. */
  command?: string
  /** What to write in `config/navigation.ts` by hand, alone or after the command. */
  byHand?: string
}

export interface PlanNavigationWorkOptions {
  /** Prefixed to each command when the app is not the directory the agent runs it from, e.g. `cd apps/shop && `. */
  cd?: string
}

// A word the shell reads as itself; anything else goes in single quotes, each `'` closed and escaped.
const quote = (value: string): string => (/^[A-Za-z0-9_./:@-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`)
// citty reads a word opening with `-` as a flag, so a value is attached with `=` and a positional follows `--`.
const flag = (name: string, value: string): string => ` --${name}=${quote(value)}`
const positional = (value: string): string => (value.startsWith('-') ? ` -- ${quote(value)}` : ` ${quote(value)}`)

const literal = (value: unknown): string => JSON.stringify(value)
const whereText = (where: NonNullable<PlanNavigation['where']>): string =>
  `{ ${where.map(({ field, value }) => `${/^[A-Za-z_$][\w$]*$/u.test(field) ? field : literal(field)}: ${literal(value)}`).join(', ')} }`

/**
 * The work left on each navigation element the step owns, read against the file's entries as they stand: an
 * added entry the file already shows as planned, a dropped one it lacks, or an alter whose stated fields hold is
 * left out. Waived elements are the caller's to leave out of `elementIds`.
 */
export function planNavigationWork(
  plan: PlanDraft,
  elementIds: readonly string[],
  entries: NavigationFileEntry[],
  options: PlanNavigationWorkOptions = {},
): PlanNavigationWork[] {
  const owned = new Set(elementIds)
  const cd = options.cd ?? ''
  const work: PlanNavigationWork[] = []
  for (const entry of plan.navigation ?? []) {
    if (!owned.has(entry.id) || entry.change.kind === 'existing') continue
    const route = navigationRouteName(plan, entry)
    const found = entries.find((candidate) => candidate.route === route)
    if (entry.change.kind === 'drop') {
      if (found) work.push({ id: entry.id, command: `${cd}bunx guren nav:remove${positional(route)}` })
      continue
    }
    if (entry.change.kind === 'alter') {
      if (!found) {
        work.push({ id: entry.id, byHand: `${route} has no entry in config/navigation.ts to alter: plan:status reports it.` })
        continue
      }
      const differing = differingFields(plan, entry, found, false)
      if (differing.length > 0) work.push({ id: entry.id, byHand: `Edit the entry for ${route}: ${differing.join(', ')}.` })
      continue
    }
    if (found) {
      const differing = differingFields(plan, entry, found, true)
      if (differing.length > 0) work.push({ id: entry.id, byHand: `The entry for ${route} is there and shows otherwise; edit it to ${differing.join(', ')}.` })
      continue
    }
    work.push(added(plan, entry, route, cd))
  }
  return work
}

/** The planned fields the entry does not show, as text to write; an add is held to its whole audience, as plan:status holds it. */
function differingFields(plan: PlanDraft, entry: PlanNavigation, found: NavigationFileEntry, whole: boolean): string[] {
  const fields: string[] = []
  if (entry.label !== undefined && entry.label !== found.label) fields.push(`label ${literal(entry.label)}`)
  if ((whole || entry.auth !== undefined) && (entry.auth ?? 'any') !== (found.auth ?? 'any')) {
    fields.push(entry.auth === undefined || entry.auth === 'any' ? 'no show.auth' : `show.auth ${literal(entry.auth)}`)
  }
  if (whole || entry.where !== undefined) {
    const planned = entry.where && Object.fromEntries(entry.where.map(({ field, value }) => [field, value]))
    if (whereKey(planned) !== whereKey(found.where)) fields.push(entry.where ? `show.where ${whereText(entry.where)}` : 'no show.where')
  }
  if (entry.can) {
    const model = modelOf(plan, entry.can.policy)
    if (found.can?.ability !== entry.can.ability || found.can.model.className !== model?.name) fields.push(`show.can ${canText(plan, entry.can)}`)
  } else if (whole && found.can) {
    fields.push('no show.can')
  }
  return fields
}

function whereKey(where: Record<string, unknown> | undefined): string {
  return where === undefined ? 'none' : literal(Object.keys(where).sort().map((field) => [field, where[field]]))
}

function added(plan: PlanDraft, entry: PlanNavigation, route: string, cd: string): PlanNavigationWork {
  const model = entry.can ? modelOf(plan, entry.can.policy) : undefined
  // nav:add imports a root model only; a module's goes in by hand.
  const canFlag = entry.can && model && model.module === undefined ? flag('can', `${entry.can.ability}:${model.name}`) : ''
  const authFlag = entry.auth === undefined || entry.auth === 'any' ? '' : flag('auth', entry.auth)
  const command = `${cd}bunx guren nav:add${flag('route', route)}${authFlag}${canFlag}${positional(entry.label ?? route)}`
  const rest = [
    entry.where === undefined ? undefined : `show.where ${whereText(entry.where)}`,
    entry.can && canFlag === '' ? `show.can ${canText(plan, entry.can)}` : undefined,
  ].filter((field): field is string => field !== undefined)
  return { id: entry.id, command, ...(rest.length > 0 ? { byHand: `Then add ${rest.join(' and ')} to the entry it writes.` } : {}) }
}

function modelOf(plan: PlanDraft, policyId: string): { name: string; module?: string } | undefined {
  const policy = plan.policies.find((candidate) => candidate.id === policyId)
  return policy ? plan.models.find((model) => model.id === policy.model) : undefined
}

function canText(plan: PlanDraft, can: NonNullable<PlanNavigation['can']>): string {
  const model = modelOf(plan, can.policy)
  const name = model ? model.name : '?'
  return `[${literal(can.ability)}, ${name}]${model?.module ? ` (imported from modules/${model.module}/app/Models/${model.name})` : ''}`
}
