/**
 * The commands `plan:next` names for a step's navigation entries (RFC 0040 §5, "One writer"): `guren nav:add`
 * and `nav:remove`, so the entries go through the writer rather than an edit by hand. What the commands cannot
 * say (an alter, a `where`, a module's model in a `can`) is named as an edit instead.
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

// A word the shell reads as itself; anything else goes in single quotes, each `'` closed and escaped.
const quote = (value: string): string => (/^[A-Za-z0-9_./:@-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`)

const whereText = (where: NonNullable<PlanNavigation['where']>): string =>
  `{ ${where.map(({ field, value }) => `${/^[A-Za-z_$][\w$]*$/u.test(field) ? field : JSON.stringify(field)}: ${JSON.stringify(value)}`).join(', ')} }`

/**
 * The work left on each navigation element the step owns, read against the file as it stands: an entry the file
 * already holds for an added route, or lacks for a dropped one, is left to `plan:status`. A file that cannot be
 * read leaves every element named.
 */
export function planNavigationWork(
  plan: PlanDraft,
  elementIds: readonly string[],
  file: NavigationFileEntry[] | { unreadable: string },
): PlanNavigationWork[] {
  const owned = new Set(elementIds)
  const listed = (route: string): boolean | undefined => (Array.isArray(file) ? file.some((entry) => entry.route === route) : undefined)
  const work: PlanNavigationWork[] = []
  for (const entry of plan.navigation ?? []) {
    if (!owned.has(entry.id) || entry.change.kind === 'existing') continue
    const route = navigationRouteName(plan, entry)
    const there = listed(route)
    if (entry.change.kind === 'drop') {
      if (there !== false) work.push({ id: entry.id, command: `bunx guren nav:remove ${quote(route)}` })
      continue
    }
    if (entry.change.kind === 'alter') {
      if (there === false) continue
      const fields = [
        entry.label === undefined ? undefined : `label ${JSON.stringify(entry.label)}`,
        entry.auth === undefined ? undefined : `auth '${entry.auth}'`,
        entry.where === undefined ? undefined : `where ${whereText(entry.where)}`,
        entry.can === undefined ? undefined : `can ${canText(plan, entry.can)}`,
      ].filter((field): field is string => field !== undefined)
      work.push({ id: entry.id, byHand: `Edit the entry for ${route}: ${fields.join(', ')}.` })
      continue
    }
    if (there === true) continue
    work.push(added(plan, entry, route))
  }
  return work
}

function added(plan: PlanDraft, entry: PlanNavigation, route: string): PlanNavigationWork {
  const model = entry.can ? modelOf(plan, entry.can.policy) : undefined
  // nav:add imports a root model only; a module's goes in by hand.
  const canFlag = entry.can && model && model.module === undefined ? ` --can ${quote(`${entry.can.ability}:${model.name}`)}` : ''
  const authFlag = entry.auth === undefined || entry.auth === 'any' ? '' : ` --auth ${entry.auth}`
  const command = `bunx guren nav:add ${quote(entry.label ?? route)} --route ${quote(route)}${authFlag}${canFlag}`
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
  return `['${can.ability}', ${name}]${model?.module ? ` (imported from modules/${model.module}/app/Models/${model.name})` : ''}`
}
