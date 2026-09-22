/**
 * What `guren plan:close` leaves behind (RFC 0030 §7), as text: the plan's doc node and one
 * marker-fenced block per section of each entity document. Pure; `plan-close.ts` reads the
 * files and writes the result. A block is keyed by plan slug and section, never by hash, so
 * closing a revision replaces the blocks its parent wrote instead of adding a second set.
 */

import { posix } from 'node:path'

import { RULES_HEADING_BY_LOCALE } from '../docs-acceptance'
import type { PlanApproval } from './approvals'
import type { PlanWaiver } from './decisions'
import { matchPlanLocale, type PlanLocale } from './locales'
import type { Plan, PlanAcceptance, PlanModel } from './schema'
import type { PlanElementState, PlanElementStatus } from './status'

/** The OKF actor both documents name as their writer. */
export const PLAN_CLOSE_ACTOR = 'process:guren-plan-close'

export const ENTITY_DOC_SECTIONS = ['purpose', 'rules', 'decisions', 'nonGoals', 'history'] as const
export type EntityDocSection = (typeof ENTITY_DOC_SECTIONS)[number]

/** `rules` is the heading `check --docs` finds uncited rules under, so it is read from there. */
export const ENTITY_DOC_HEADINGS: Record<PlanLocale, Record<EntityDocSection, string>> = {
  en: { purpose: 'Purpose', rules: RULES_HEADING_BY_LOCALE.en, decisions: 'Decisions', nonGoals: 'Non-goals', history: 'History' },
  ja: { purpose: '目的', rules: RULES_HEADING_BY_LOCALE.ja, decisions: '決定事項', nonGoals: '対象外', history: '履歴' },
}

const WORDS: Record<PlanLocale, Record<string, string>> = {
  en: {
    waived: 'Waived',
    closed: 'closed plan',
    approved: 'Approved',
    by: 'by',
    planFile: 'Plan file',
    scope: 'Scope',
    goals: 'Goals',
    nonGoals: 'Non-goals',
    assumptions: 'Assumptions',
    decisions: 'Decisions',
    noWaivers: 'No element was waived; every one was verified.',
    elements: 'Elements',
    element: 'Element',
    change: 'Change',
    state: 'State',
    acceptance: 'Acceptance',
    entities: 'Entity documents',
  },
  ja: {
    waived: '免除',
    closed: '完了したプラン',
    approved: '承認',
    by: '承認者',
    planFile: 'プランファイル',
    scope: 'スコープ',
    goals: '目標',
    nonGoals: '対象外',
    assumptions: '前提',
    decisions: '決定事項',
    noWaivers: '免除した要素はありません。すべて検証済みです。',
    elements: '要素',
    element: '要素',
    change: '変更',
    state: '状態',
    acceptance: '受け入れ条件',
    entities: '関連エンティティ',
  },
}

export function closeLocale(plan: Pick<Plan, 'locale'>): PlanLocale {
  return matchPlanLocale(plan.locale) ?? 'en'
}

export interface PlanCloseContext {
  plan: Plan
  hash: string
  /** Names the blocks; a revision closes under its parent's. */
  slug: string
  approval: PlanApproval
  /** The overlaid status elements, every one of which is `verified` or `waived` unless `existing`. */
  elements: ReadonlyArray<PlanElementStatus<PlanElementState>>
  /** The waivers that lifted an element to `waived`, by element id. */
  waivers: ReadonlyMap<string, PlanWaiver>
  /** App-relative, POSIX: the plan file, or `undefined` when it sits outside the application. */
  planFile?: string
  /** App-relative, POSIX. */
  planDocPath: string
  entityDocPath: (model: PlanModel) => string
}

/** The models a closed plan touched: what it adds, alters or renames. A dropped model has no document to govern. */
export function touchedModels(plan: Plan): PlanModel[] {
  return plan.models.filter((model) => model.change.kind === 'add' || model.change.kind === 'alter' || model.change.kind === 'rename')
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function relativeLink(from: string, to: string): string {
  const target = posix.relative(posix.dirname(from), to)
  return /[\s()<>]/u.test(target) ? `<${target}>` : target
}

function waiverLine(locale: PlanLocale, waiver: PlanWaiver): string {
  return `- ${WORDS[locale].waived} \`${waiver.elementId}\`: ${waiver.reason} (${waiver.at}${waiver.by ? `, ${waiver.by}` : ''})`
}

function cite(text: string, ids: readonly string[]): string {
  return ids.length > 0 ? `${text} (${ids.join(', ')})` : text
}

/** The plan's doc node, `docs/plans/<slug>.md`: `type: plan`, governing what it touched. */
export function renderPlanDoc(context: PlanCloseContext): string {
  const { plan, hash, approval } = context
  const locale = closeLocale(plan)
  const words = WORDS[locale]
  const models = touchedModels(plan)
  const verifiedBy = approval.approvedBy ? `human:${approval.approvedBy}` : 'process:guren-plan-approve'
  const lines = [
    '---',
    'type: plan',
    `entities: [${models.map((model) => model.name).join(', ')}]`,
    'closed: true',
    `plan_hash: ${hash}`,
    `generated: { by: ${PLAN_CLOSE_ACTOR} }`,
    'verified:',
    `  - by: ${yamlString(verifiedBy)}`,
    `    at: ${yamlString(approval.approvedAt)}`,
    '---',
    '',
    `# ${plan.title}`,
    '',
    plan.summary,
    '',
    context.planFile
      ? `${words.planFile}: [${posix.basename(context.planFile)}](${relativeLink(context.planDocPath, context.planFile)})`
      : `${words.planFile}: \`${context.slug}\``,
    '',
    `${words.approved} \`${hash}\` ${approval.approvedAt}${approval.approvedBy ? ` (${words.by} ${approval.approvedBy})` : ''}.`,
    '',
  ]
  if (models.length > 0) {
    lines.push(`## ${words.entities}`, '')
    for (const model of models) lines.push(`- [${model.name}](${relativeLink(context.planDocPath, context.entityDocPath(model))})`)
    lines.push('')
  }
  const scope = [
    ...(plan.scope.goals.length > 0 ? [`${words.goals}:`, '', ...bullets(plan.scope.goals), ''] : []),
    ...(plan.scope.nonGoals.length > 0 ? [`${words.nonGoals}:`, '', ...bullets(plan.scope.nonGoals), ''] : []),
  ]
  if (scope.length > 0) lines.push(`## ${words.scope}`, '', ...scope)
  if (plan.assumptions.length > 0) lines.push(`## ${words.assumptions}`, '', ...bullets(plan.assumptions), '')

  lines.push(`## ${words.decisions}`, '')
  const waived = context.elements.filter((element) => element.state === 'waived').map((element) => context.waivers.get(element.id))
  const waiverLines = waived.filter((waiver) => waiver !== undefined).map((waiver) => waiverLine(locale, waiver))
  lines.push(...(waiverLines.length > 0 ? waiverLines : [words.noWaivers]), '')

  lines.push(`## ${words.elements}`, '', `| ${words.element} | ${words.change} | ${words.state} |`, '| --- | --- | --- |')
  for (const element of context.elements) {
    if (element.change === 'existing') continue
    lines.push(`| \`${element.id}\` | ${element.change} | ${element.state} |`)
  }
  lines.push('')

  const behaviours = plan.tasks.flatMap((task) => task.acceptance)
  if (behaviours.length > 0) {
    lines.push(`## ${words.acceptance}`, '', ...behaviours.map((behaviour) => `- ${cite(behaviour.description, [behaviour.id])}`), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`)
}

/** Section → the block's content lines for one entity, a section with nothing to say absent. */
export function entityDocBlocks(context: PlanCloseContext, model: PlanModel): Partial<Record<EntityDocSection, string[]>> {
  const { plan } = context
  const locale = closeLocale(plan)
  const named = (entity: string): boolean => entity.toLowerCase() === model.name.toLowerCase()
  const tasks = plan.tasks.filter((task) => named(task.entity))
  const blocks: Partial<Record<EntityDocSection, string[]>> = {}

  if (tasks.length > 0) blocks.purpose = tasks.map((task) => task.summary)

  const rules = entityRules(plan, model, tasks.flatMap((task) => task.acceptance))
  if (rules.length > 0) blocks.rules = rules

  const owned = new Set([model.id, ...model.columns.map((column) => column.id), ...tasks.flatMap((task) => task.covers)])
  for (const controller of plan.controllers) if (owned.has(controller.id)) for (const action of controller.actions) owned.add(action.id)
  for (const section of [plan.policies, plan.resources]) for (const entry of section) if (entry.model === model.id) owned.add(entry.id)
  const waivers = context.elements
    .filter((element) => element.state === 'waived' && owned.has(element.id))
    .map((element) => context.waivers.get(element.id))
    .filter((waiver) => waiver !== undefined)
  if (waivers.length > 0) blocks.decisions = waivers.map((waiver) => waiverLine(locale, waiver))

  if (tasks.length > 0 && plan.scope.nonGoals.length > 0) blocks.nonGoals = plan.scope.nonGoals.map((item) => `- ${item}`)

  const link = relativeLink(context.entityDocPath(model), context.planDocPath)
  blocks.history = [`- [${plan.title}](${link}): ${WORDS[locale].closed} \`${context.hash.slice(0, 12)}\``]
  return blocks
}

/**
 * The entity's behaviours, then each rule an action or a policy ability states, citing the
 * behaviours that reach it through a route. A rule nothing reaches is written uncited, which
 * `check --docs` reports: that is the finding the RFC asks for, not a defect of the writer.
 */
function entityRules(plan: Plan, model: PlanModel, behaviours: readonly PlanAcceptance[]): string[] {
  const actionOfRoute = new Map(plan.routes.map((route) => [route.id, route.action]))
  const byAction = new Map<string, string[]>()
  for (const behaviour of behaviours) {
    const action = actionOfRoute.get(behaviour.route)
    if (action) byAction.set(action, [...(byAction.get(action) ?? []), behaviour.id])
  }
  const allBehaviours = plan.tasks.flatMap((task) => task.acceptance)
  const lines = behaviours.map((behaviour) => `- ${cite(behaviour.description, [behaviour.id])}`)
  const push = (line: string): void => {
    if (!lines.includes(line)) lines.push(line)
  }

  for (const controller of plan.controllers) {
    for (const action of controller.actions) {
      const ids = byAction.get(action.id)
      if (!ids || action.change.kind === 'existing') continue
      for (const rule of action.rules) push(`- ${cite(rule, ids)}`)
    }
  }
  for (const policy of plan.policies) {
    if (policy.model !== model.id || policy.change.kind === 'existing') continue
    for (const ability of policy.abilities) {
      const actions = plan.controllers
        .flatMap((controller) => controller.actions)
        .filter((action) => action.authorization.policy?.id === policy.id && action.authorization.policy.ability === ability.name)
        .map((action) => action.id)
      const ids = allBehaviours.filter((behaviour) => actions.includes(actionOfRoute.get(behaviour.route) ?? '')).map((behaviour) => behaviour.id)
      push(`- ${cite(ability.rule, ids)}`)
    }
  }
  return lines
}

/** A new entity document: OKF frontmatter naming the entity, and its title. */
export function newEntityDoc(model: PlanModel): string {
  return ['---', 'type: entity', `entities: [${model.name}]`, `generated: { by: ${PLAN_CLOSE_ACTOR} }`, '---', '', `# ${model.name}`, ''].join('\n')
}

const openMarker = (slug: string, hash: string, section: EntityDocSection): string => `<!-- guren:plan ${slug} ${hash} ${section} -->`
const closeMarker = (slug: string, section: EntityDocSection): string => `<!-- /guren:plan ${slug} ${section} -->`

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** The block of `slug` and `section`, whatever hash it names, as a span of `text`. */
function findBlock(text: string, slug: string, section: EntityDocSection): { start: number; end: number } | undefined {
  const open = new RegExp(`<!-- guren:plan ${escapeRegExp(slug)} \\S+ ${section} -->`, 'u').exec(text)
  if (!open) return undefined
  const close = text.indexOf(closeMarker(slug, section), open.index)
  if (close === -1) return undefined
  return { start: open.index, end: close + closeMarker(slug, section).length }
}

/** The line index of a `## ` heading naming `section` in any plan locale, fences skipped. */
function findHeading(lines: readonly string[], section: EntityDocSection): number {
  const names = new Set(Object.values(ENTITY_DOC_HEADINGS).map((headings) => headings[section]))
  let inFence = false
  for (let index = 0; index < lines.length; index++) {
    if (/^\s*```/u.test(lines[index])) inFence = !inFence
    const heading = inFence ? null : /^##\s+(.+?)\s*#*\s*$/u.exec(lines[index])
    if (heading && names.has(heading[1])) return index
  }
  return -1
}

/**
 * `document` with the block of `slug` and `section` set to `content`: replaced between its
 * markers where one exists, otherwise inserted at the end of that section, or appended under a
 * new heading. Nothing outside a block is rewritten. `content` absent removes an existing block.
 */
export function spliceEntityBlock(
  document: string,
  options: { slug: string; hash: string; section: EntityDocSection; content?: readonly string[]; locale: PlanLocale },
): string {
  const { slug, hash, section, content } = options
  const block = content ? [openMarker(slug, hash, section), ...content, closeMarker(slug, section)].join('\n') : undefined
  const existing = findBlock(document, slug, section)
  if (existing) {
    if (block) return `${document.slice(0, existing.start)}${block}${document.slice(existing.end)}`
    const after = document.slice(existing.end).replace(/^\r?\n(?:\r?\n)?/u, '')
    return `${document.slice(0, existing.start)}${after}`
  }
  if (!block) return document

  const lines = document.split('\n')
  const heading = findHeading(lines, section)
  if (heading === -1) {
    return `${document.trimEnd()}\n\n## ${ENTITY_DOC_HEADINGS[options.locale][section]}\n\n${block}\n`
  }
  let next = lines.findIndex((line, index) => index > heading && /^#{1,2}\s/u.test(line))
  if (next === -1) next = lines.length
  let last = next - 1
  while (last > heading && lines[last].trim() === '') last--
  const tail = lines.slice(next)
  return [...lines.slice(0, last + 1), '', block, ...(tail.length > 0 ? ['', ...tail] : [''])].join('\n')
}

/** Every section of one entity document, in order: what a run writes for that entity. */
export function renderEntityDoc(document: string | undefined, context: PlanCloseContext, model: PlanModel): string {
  const blocks = entityDocBlocks(context, model)
  const locale = closeLocale(context.plan)
  let text = document ?? newEntityDoc(model)
  for (const section of ENTITY_DOC_SECTIONS) {
    text = spliceEntityBlock(text, { slug: context.slug, hash: context.hash, section, content: blocks[section], locale })
  }
  return text
}
