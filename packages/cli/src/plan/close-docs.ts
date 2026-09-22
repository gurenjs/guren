/**
 * What `guren plan:close` leaves behind (RFC 0030 §7), as text: the plan's doc node and one
 * marker-fenced block per section of each entity document. Pure; `plan-close.ts` reads the
 * files and writes the result. A block is keyed by plan slug and section, never by hash, so
 * closing a revision replaces the blocks its parent wrote instead of adding a second set.
 */

import { posix } from 'node:path'

import { RULES_HEADING_BY_LOCALE } from '../docs-acceptance'
import { parseDocFrontmatter } from '../docs-frontmatter'
import { markdownLines } from '../docs-links'
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
  const data = parseDocFrontmatter(source)?.data
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

const OPEN_MARKER = /^<!-- guren:plan (\S+) (\S+) (\S+) -->$/u
const CLOSE_MARKER = /^<!-- \/guren:plan (\S+) (\S+) -->$/u
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/u

interface EntityDocLines {
  lines: string[]
  inFence: boolean[]
  eol: '\n' | '\r\n'
  /** `<slug> <section>` → the lines of its open and close markers. */
  blocks: Map<string, { open: number; close: number }>
}

/**
 * The document's lines and its blocks, or what makes its markers unsafe to rewrite: an open
 * marker with no close before the next marker or heading, a close with no open, a pair that
 * appears twice, a marker inside a code fence. Any of these, and a rewrite could delete a
 * person's text or never converge, so the caller refuses rather than guesses.
 */
export function readEntityDoc(document: string): { doc: EntityDocLines; problems: string[] } {
  const scanned = markdownLines(document)
  const doc: EntityDocLines = {
    lines: scanned.lines.map((line) => line.text),
    inFence: scanned.lines.map((line) => line.inFence),
    eol: document.includes('\r\n') ? '\r\n' : '\n',
    blocks: new Map(),
  }
  // Everything after an unclosed fence reads as code, so a block written there would be code too.
  if (scanned.unclosedFence !== undefined) return { doc, problems: [`line ${scanned.unclosedFence + 1}: a code fence opens here and never closes`] }
  const problems: string[] = []
  let open: { key: string; line: number } | undefined
  const unclosed = (): void => {
    if (open) problems.push(`line ${open.line + 1}: the block "${open.key}" opens and never closes`)
    open = undefined
  }
  doc.lines.forEach((text, index) => {
    const opening = OPEN_MARKER.exec(text)
    const closing = CLOSE_MARKER.exec(text)
    if ((opening || closing) && doc.inFence[index]) {
      problems.push(`line ${index + 1}: a guren:plan marker sits inside a code fence`)
      return
    }
    if (opening) {
      unclosed()
      open = { key: `${opening[1]} ${opening[3]}`, line: index }
    } else if (closing) {
      const key = `${closing[1]} ${closing[2]}`
      if (open?.key !== key) {
        unclosed()
        problems.push(`line ${index + 1}: the block "${key}" closes and never opened`)
      } else if (doc.blocks.has(key)) {
        problems.push(`line ${open.line + 1}: the block "${key}" appears twice`)
        open = undefined
      } else {
        doc.blocks.set(key, { open: open.line, close: index })
        open = undefined
      }
    } else if (!doc.inFence[index] && HEADING.test(text)) {
      unclosed()
    }
  })
  unclosed()
  return { doc, problems }
}

/** The line of a `## ` heading naming `section` in any plan locale, outside code. */
function findHeading(doc: EntityDocLines, section: EntityDocSection): number {
  const names = new Set(Object.values(ENTITY_DOC_HEADINGS).map((headings) => headings[section]))
  return doc.lines.findIndex((line, index) => {
    const heading = doc.inFence[index] ? null : HEADING.exec(line)
    return heading !== null && heading[1] === '##' && names.has(heading[2])
  })
}

/**
 * The lines with the block of `slug` and `section` set to `content`: replaced between its
 * markers where one exists, otherwise inserted at the end of that section, or appended under a
 * new heading. No text outside a block is rewritten, but a document mixing line endings comes
 * back with its first CRLF, or LF, throughout. `content` absent removes an existing block.
 */
function spliceLines(doc: EntityDocLines, options: { slug: string; hash: string; section: EntityDocSection; content?: readonly string[]; locale: PlanLocale }): string[] {
  const { slug, hash, section, content } = options
  const block = content ? [`<!-- guren:plan ${slug} ${hash} ${section} -->`, ...content, `<!-- /guren:plan ${slug} ${section} -->`] : undefined
  const { lines } = doc
  const existing = doc.blocks.get(`${slug} ${section}`)
  if (existing) {
    if (block) return [...lines.slice(0, existing.open), ...block, ...lines.slice(existing.close + 1)]
    // The blank line this writer put before the block goes with it.
    const start = existing.open > 0 && lines[existing.open - 1] === '' ? existing.open - 1 : existing.open
    return [...lines.slice(0, start), ...lines.slice(existing.close + 1)]
  }
  if (!block) return lines

  const heading = findHeading(doc, section)
  if (heading === -1) {
    let end = lines.length
    while (end > 0 && lines[end - 1] === '') end--
    return [...lines.slice(0, end), '', `## ${ENTITY_DOC_HEADINGS[options.locale][section]}`, '', ...block, '']
  }
  let next = lines.findIndex((line, index) => index > heading && !doc.inFence[index] && /^#{1,2}\s/u.test(line))
  if (next === -1) next = lines.length
  let last = next - 1
  while (last > heading && lines[last].trim() === '') last--
  const tail = lines.slice(next)
  return [...lines.slice(0, last + 1), '', ...block, ...(tail.length > 0 ? ['', ...tail] : [''])]
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
