/**
 * What `guren plan:close` leaves behind (RFC 0030 §7), as text: the plan's doc node and one
 * marker-fenced block per section of each entity document. Pure; `plan-close.ts` reads the
 * files and writes the result. A block is keyed by plan slug and section, never by hash, so
 * closing a revision replaces the blocks its parent wrote instead of adding a second set.
 */

import { posix } from 'node:path'

import { RULES_HEADING_BY_LOCALE } from '../docs-acceptance'
import { parseDocFrontmatter, type DocFrontmatterValue } from '../docs-frontmatter'
import { readMarkedLines, spliceMarkedBlock, type MarkedLines, type MarkerSyntax } from '../marker-blocks'
import type { PlanApproval } from './approvals'
import type { PlanWaiver } from './decisions'
import { matchPlanLocale, type PlanLocale } from './locales'
import type { Plan, PlanAcceptance, PlanModel } from './schema'
import type { PlanElementState, PlanElementStatus } from './status'
import { modelNamed } from './tasks'

const PLAN_CLOSE_ACTOR = 'process:guren-plan-close'

const ENTITY_DOC_SECTIONS = ['purpose', 'rules', 'decisions', 'nonGoals', 'history'] as const
export type EntityDocSection = (typeof ENTITY_DOC_SECTIONS)[number]

// `rules` is the heading `check --docs` finds uncited rules under, so it is read from there.
const ENTITY_DOC_HEADINGS: Record<PlanLocale, Record<EntityDocSection, string>> = {
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

function closeLocale(plan: Pick<Plan, 'locale'>): PlanLocale {
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
  /** The waivers that lifted an element to `waived`, by element id, in element order. */
  waived: ReadonlyMap<string, PlanWaiver>
  /** App-relative, POSIX: the plan file, or `undefined` when it sits outside the application. */
  planFile?: string
}

/** App-relative, POSIX. */
export function planDocPath(slug: string): string {
  return `docs/plans/${slug}.md`
}

/** App-relative, POSIX; a module's model is documented in that module's bundle. */
export function entityDocPath(model: PlanModel): string {
  return model.module ? `modules/${model.module}/docs/entities/${model.name}.md` : `docs/entities/${model.name}.md`
}

/** The models a closed plan touched: what it adds, alters or renames. A dropped model has no document to govern. */
export function touchedModels(plan: Plan): PlanModel[] {
  return plan.models.filter((model) => model.change.kind === 'add' || model.change.kind === 'alter' || model.change.kind === 'rename')
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

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`)
}

/**
 * The hash a doc node written by {@link renderPlanDoc} says its plan closed at, or `undefined`
 * for a document that does not say it is closed. The frontmatter reader returns scalars as strings.
 */
export function planDocClosedHash(source: string): string | undefined {
  return planDocClosedHashIn(parseDocFrontmatter(source)?.data)
}

/** {@link planDocClosedHash} over frontmatter a caller has already parsed. */
export function planDocClosedHashIn(data: Record<string, DocFrontmatterValue> | undefined): string | undefined {
  return data?.closed === 'true' && typeof data.plan_hash === 'string' ? data.plan_hash : undefined
}

/** The plan's doc node, `docs/plans/<slug>.md`: `type: plan`, governing what it touched. */
export function renderPlanDoc(context: PlanCloseContext): string {
  const { plan, hash, approval } = context
  const locale = closeLocale(plan)
  const words = WORDS[locale]
  const models = touchedModels(plan)
  const self = planDocPath(context.slug)
  const verifiedBy = approval.approvedBy ? `human:${approval.approvedBy}` : 'process:guren-plan-approve'
  const lines = [
    '---',
    'type: plan',
    `entities: [${models.map((model) => model.name).join(', ')}]`,
    'closed: true',
    `plan_hash: ${hash}`,
    `generated: { by: ${PLAN_CLOSE_ACTOR} }`,
    'verified:',
    `  - by: ${JSON.stringify(verifiedBy)}`,
    `    at: ${JSON.stringify(approval.approvedAt)}`,
    '---',
    '',
    `# ${plan.title}`,
    '',
    plan.summary,
    '',
    context.planFile
      ? `${words.planFile}: [${posix.basename(context.planFile)}](${relativeLink(self, context.planFile)})`
      : `${words.planFile}: \`${context.slug}\``,
    '',
    `${words.approved} \`${hash}\` ${approval.approvedAt}${approval.approvedBy ? ` (${words.by} ${approval.approvedBy})` : ''}.`,
    '',
  ]
  if (models.length > 0) {
    lines.push(`## ${words.entities}`, '', ...models.map((model) => `- [${model.name}](${relativeLink(self, entityDocPath(model))})`), '')
  }
  const scope = [
    ...(plan.scope.goals.length > 0 ? [`${words.goals}:`, '', ...bullets(plan.scope.goals), ''] : []),
    ...(plan.scope.nonGoals.length > 0 ? [`${words.nonGoals}:`, '', ...bullets(plan.scope.nonGoals), ''] : []),
  ]
  if (scope.length > 0) lines.push(`## ${words.scope}`, '', ...scope)
  if (plan.assumptions.length > 0) lines.push(`## ${words.assumptions}`, '', ...bullets(plan.assumptions), '')

  const waiverLines = [...context.waived.values()].map((waiver) => waiverLine(locale, waiver))
  lines.push(`## ${words.decisions}`, '', ...(waiverLines.length > 0 ? waiverLines : [words.noWaivers]), '')

  lines.push(`## ${words.elements}`, '', `| ${words.element} | ${words.change} | ${words.state} |`, '| --- | --- | --- |')
  for (const element of context.elements) {
    if (element.change !== 'existing') lines.push(`| \`${element.id}\` | ${element.change} | ${element.state} |`)
  }
  lines.push('')

  const behaviours = plan.tasks.flatMap((task) => task.acceptance)
  if (behaviours.length > 0) lines.push(`## ${words.acceptance}`, '', ...bullets(behaviours.map((behaviour) => cite(behaviour.description, [behaviour.id]))), '')
  return `${lines.join('\n').trimEnd()}\n`
}

/** Section → the block's content lines for one entity, a section with nothing to say absent. */
function entityDocBlocks(context: PlanCloseContext, model: PlanModel): Partial<Record<EntityDocSection, string[]>> {
  const { plan } = context
  const locale = closeLocale(plan)
  // The rule the task derivation reads an intent's entity with, so both agree on whose task it is.
  const tasks = plan.tasks.filter((task) => modelNamed(plan.models, task.entity) === model)
  const blocks: Partial<Record<EntityDocSection, string[]>> = {}

  if (tasks.length > 0) blocks.purpose = tasks.map((task) => task.summary)

  const rules = entityRules(plan, model, tasks.flatMap((task) => task.acceptance))
  if (rules.length > 0) blocks.rules = rules

  const owned = new Set([model.id, ...model.columns.map((column) => column.id), ...tasks.flatMap((task) => task.covers)])
  for (const controller of plan.controllers) if (owned.has(controller.id)) for (const action of controller.actions) owned.add(action.id)
  for (const section of [plan.policies, plan.resources]) for (const entry of section) if (entry.model === model.id) owned.add(entry.id)
  const waivers = [...context.waived.values()].filter((waiver) => owned.has(waiver.elementId))
  if (waivers.length > 0) blocks.decisions = waivers.map((waiver) => waiverLine(locale, waiver))

  if (tasks.length > 0 && plan.scope.nonGoals.length > 0) blocks.nonGoals = bullets(plan.scope.nonGoals)

  const link = relativeLink(entityDocPath(model), planDocPath(context.slug))
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
  const lines = bullets(behaviours.map((behaviour) => cite(behaviour.description, [behaviour.id])))
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

function newEntityDoc(model: PlanModel): string {
  return ['---', 'type: entity', `entities: [${model.name}]`, `generated: { by: ${PLAN_CLOSE_ACTOR} }`, '---', '', `# ${model.name}`, ''].join('\n')
}

const PLAN_MARKERS: MarkerSyntax<{ slug: string; hash: string; section: string }> = {
  name: 'guren:plan',
  open(line) {
    const match = /^<!-- guren:plan (\S+) (\S+) (\S+) -->$/u.exec(line)
    return match ? { key: `${match[1]} ${match[3]}`, data: { slug: match[1]!, hash: match[2]!, section: match[3]! } } : undefined
  },
  close(line) {
    const match = /^<!-- \/guren:plan (\S+) (\S+) -->$/u.exec(line)
    return match ? `${match[1]} ${match[2]}` : undefined
  },
}

type EntityDocLines = MarkedLines<{ slug: string; hash: string; section: string }>

/** The document's lines and its `guren:plan` blocks keyed `<slug> <section>`, or what makes them unsafe to rewrite. */
export function readEntityDoc(document: string): { doc: EntityDocLines; problems: string[] } {
  return readMarkedLines(document, PLAN_MARKERS)
}

export interface PlanDocBlock {
  slug: string
  hash: string
  section: string
  /** Lines of the open and close markers, in `lines`. */
  open: number
  close: number
}

/**
 * The blocks `plan:close` fenced in a document, in document order, over its lines as
 * {@link readEntityDoc} split them; `undefined` wherever that reader reports a problem.
 */
export function readPlanBlocks(document: string): { lines: string[]; blocks: PlanDocBlock[] } | undefined {
  const { doc, problems } = readEntityDoc(document)
  if (problems.length > 0) return undefined
  return { lines: doc.lines, blocks: [...doc.blocks.values()].map(({ data, open, close }) => ({ ...data, open, close })) }
}

/**
 * The lines with the block of `slug` and `section` set to `content` ({@link spliceMarkedBlock}),
 * under the section's heading in any plan locale. A document mixing line endings comes back with
 * its first CRLF, or LF, throughout. `content` absent removes an existing block.
 */
function spliceLines(doc: EntityDocLines, options: { slug: string; hash: string; section: EntityDocSection; content?: readonly string[]; locale: PlanLocale }): string[] {
  const { slug, hash, section, content } = options
  const fenced = content ? [`<!-- guren:plan ${slug} ${hash} ${section} -->`, ...content, `<!-- /guren:plan ${slug} ${section} -->`] : undefined
  return spliceMarkedBlock(doc, `${slug} ${section}`, fenced, {
    headings: new Set(Object.values(ENTITY_DOC_HEADINGS).map((headings) => headings[section])),
    newHeading: ENTITY_DOC_HEADINGS[options.locale][section],
  })
}

/** {@link spliceLines} over a whole document, for one section; throws where {@link readEntityDoc} finds a problem. */
export function spliceEntityBlock(document: string, options: { slug: string; hash: string; section: EntityDocSection; content?: readonly string[]; locale: PlanLocale }): string {
  const { doc, problems } = readEntityDoc(document)
  if (problems.length > 0) throw new Error(problems.join('; '))
  return spliceLines(doc, options).join(doc.eol)
}

/**
 * Every section of one entity document, in order: what a run writes for that entity, or the
 * problems that make its markers unsafe to rewrite.
 */
export function renderEntityDoc(document: string | undefined, context: PlanCloseContext, model: PlanModel): { content: string } | { problems: string[] } {
  const blocks = entityDocBlocks(context, model)
  const locale = closeLocale(context.plan)
  let text = document ?? newEntityDoc(model)
  const first = readEntityDoc(text)
  if (first.problems.length > 0) return { problems: first.problems }
  for (const section of ENTITY_DOC_SECTIONS) {
    text = spliceEntityBlock(text, { slug: context.slug, hash: context.hash, section, content: blocks[section], locale })
  }
  return { content: text }
}
