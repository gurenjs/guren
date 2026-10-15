/**
 * The feature map of RFC 0033 §2, pure: features from the Application Graph (RFC 0032) and the
 * approved plans (RFC 0030), and the documents `browser:map` writes. A feature is the first path
 * segment of an Inertia page. Nothing here is inferred from a name: a route joins a feature only
 * through its `handles` edge and the `controller:<action>` evidence of a `renders` edge.
 */

import { posix } from 'node:path'

import type { GraphNode, GurenApplicationGraph } from './application-graph'
import { findHeadingLine, readMarkedLines, type MarkedLines, type MarkerSyntax } from './marker-blocks'
import type { Plan, PlanAcceptance, PlanView } from './plan/schema'

export const BROWSER_MAP_DIR = 'docs/browser'
export const BROWSER_MAP_INDEX = `${BROWSER_MAP_DIR}/README.md`
const BROWSER_MAP_ACTOR = 'process:guren-browser-map'

/** The graph sections the feature set rests on; another section's gap is reported where it is read. */
export const BROWSER_MAP_SECTIONS = ['route', 'controller', 'page', 'handles', 'renders'] as const

export interface BrowserMapRoute {
  method: string
  path: string
  name?: string
  middleware: string[]
  /** The pages its action renders, in this feature or any other; more than one is never narrowed. */
  pages: string[]
}

export interface BrowserMapAcceptance {
  /** App-relative, POSIX. */
  plan: string
  acceptance: PlanAcceptance
  route: { method: string; path: string; name: string }
  /** `expect.inertia` resolved through the plan's views. */
  page?: string
}

export interface BrowserMapView {
  plan: string
  view: PlanView
}

export interface BrowserFeature {
  name: string
  /** App-relative, POSIX. */
  file: string
  pages: string[]
  routes: BrowserMapRoute[]
  landmark?: BrowserMapRoute
  entities: string[]
  acceptance: BrowserMapAcceptance[]
  views: BrowserMapView[]
}

export interface BrowserMapGap {
  section: string
  reasons: string[]
}

export interface BrowserMap {
  /** The feature set's sections were read completely from a stable snapshot. */
  complete: boolean
  gaps: BrowserMapGap[]
  /** Set when middleware lists may be short. */
  middlewareGap?: BrowserMapGap
  features: BrowserFeature[]
  unreached: string[]
  unassigned: Array<{ method: string; path: string; name?: string; reason: string; candidates: string[] }>
  unresolvedRenders: Array<{ controller: string; target: string; reason: string }>
  /** Acceptance whose route the app does not register yet. */
  unplaced: Array<{ plan: string; id: string; route: string }>
  plans: string[]
  unreadablePlans: Array<{ plan: string; reason: string }>
}

export interface ApprovedPlanInput {
  /** App-relative, POSIX. */
  file: string
  plan: Plan
}

export function featureOfPage(page: Pick<GraphNode, 'label' | 'module'>): string {
  const segment = page.label.split('/')[0]!
  return page.module ? `${page.module}/${segment}` : segment
}

export function featureFile(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'feature'
  return `${BROWSER_MAP_DIR}/${slug}.md`
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isParameterless(path: string): boolean {
  return !/[:*]/u.test(path)
}

export function buildBrowserMap(
  graph: GurenApplicationGraph,
  plans: readonly ApprovedPlanInput[],
  unreadablePlans: BrowserMap['unreadablePlans'] = [],
): BrowserMap {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const gaps: BrowserMapGap[] = []
  if (graph.snapshot.consistency !== 'stable') gaps.push({ section: 'snapshot', reasons: ['Sources changed while the graph was read.'] })
  for (const section of BROWSER_MAP_SECTIONS) {
    const coverage = graph.coverage[section]
    if (coverage && coverage.status !== 'complete') {
      gaps.push({ section, reasons: coverage.reasons.map((reason) => reason.file ? `${reason.message} (${reason.file})` : reason.message) })
    }
  }
  const middlewareCoverage = graph.coverage.usesMiddleware
  const middlewareGap = middlewareCoverage && middlewareCoverage.status !== 'complete'
    ? { section: 'usesMiddleware', reasons: middlewareCoverage.reasons.map((reason) => reason.message) }
    : undefined

  const edgesFrom = (from: string, relation: string) => graph.edges.filter((edge) => edge.from === from && edge.relation === relation)
  const rendersByController = new Map<string, Array<{ page: GraphNode; actions: Set<string> }>>()
  for (const edge of graph.edges) {
    if (edge.relation !== 'renders') continue
    const page = nodes.get(edge.to)
    if (!page) continue
    const actions = new Set(edge.evidence.flatMap((entry) => entry.source.startsWith('controller:') ? [entry.source.slice('controller:'.length)] : []))
    const list = rendersByController.get(edge.from) ?? []
    list.push({ page, actions })
    rendersByController.set(edge.from, list)
  }

  const features = new Map<string, BrowserFeature>()
  const feature = (name: string): BrowserFeature => {
    let entry = features.get(name)
    if (!entry) {
      entry = { name, file: featureFile(name), pages: [], routes: [], entities: [], acceptance: [], views: [] }
      features.set(name, entry)
    }
    return entry
  }
  const pages = graph.nodes.filter((node) => node.kind === 'page')
  const reached = new Set<string>()
  const routeFeatures = new Map<string, string[]>()
  const unassigned: BrowserMap['unassigned'] = []
  const entities = new Map<string, Set<string>>()

  const routes = graph.nodes
    .filter((node): node is GraphNode & { route: NonNullable<GraphNode['route']> } => node.kind === 'route' && node.route !== undefined)
    .sort((a, b) => a.route.order - b.route.order)
  for (const node of routes) {
    const { method, path, name, action } = node.route
    const base = { method, path, ...(name ? { name } : {}) }
    const controllers = edgesFrom(node.id, 'handles').map((edge) => edge.to)
    if (controllers.length === 0 || action === undefined) {
      unassigned.push({ ...base, reason: action === undefined ? 'Not handled by a controller action.' : 'Its controller could not be identified.', candidates: [] })
      continue
    }
    const renders = controllers.flatMap((controller) => rendersByController.get(controller) ?? [])
    const rendered = renders.filter((entry) => entry.actions.has(action)).map((entry) => entry.page)
    let owners: string[]
    if (rendered.length > 0) {
      for (const page of rendered) reached.add(page.id)
      owners = [...new Set(rendered.map(featureOfPage))]
    } else {
      const candidates = [...new Set(renders.map((entry) => featureOfPage(entry.page)))].sort(compare)
      if (candidates.length !== 1) {
        unassigned.push({ ...base, reason: candidates.length === 0 ? 'Its action renders nothing, and neither does its controller.' : 'Its action renders nothing, and its controller renders pages in several features.', candidates })
        continue
      }
      owners = candidates
    }
    const middleware = edgesFrom(node.id, 'usesMiddleware').flatMap((edge) => nodes.get(edge.to)?.label ?? []).sort(compare)
    const route: BrowserMapRoute = { ...base, middleware, pages: [...new Set(rendered.map((page) => page.label))].sort(compare) }
    const bound = edgesFrom(node.id, 'binds').flatMap((edge) => nodes.get(edge.to)?.label ?? [])
    routeFeatures.set(node.id, owners)
    for (const owner of owners) {
      const entry = feature(owner)
      entry.routes.push(route)
      if (!entry.landmark && method === 'GET' && route.pages.length > 0 && isParameterless(path)) entry.landmark = route
      const names = entities.get(owner) ?? new Set()
      for (const model of bound) names.add(model)
      entities.set(owner, names)
    }
  }
  for (const page of pages) {
    if (!reached.has(page.id)) continue
    feature(featureOfPage(page)).pages.push(page.label)
  }
  for (const entry of features.values()) {
    entry.pages.sort(compare)
    entry.entities = [...(entities.get(entry.name) ?? [])].sort(compare)
  }

  const unplaced: BrowserMap['unplaced'] = []
  for (const { file, plan } of plans) {
    for (const acceptance of plan.tasks.flatMap((task) => task.acceptance)) {
      const planRoute = plan.routes.find((route) => route.id === acceptance.route)
      const matches = planRoute ? routes.filter((node) => node.route.name === planRoute.name && node.route.method === planRoute.method) : []
      const owners = [...new Set(matches.flatMap((node) => routeFeatures.get(node.id) ?? []))]
      if (!planRoute || owners.length === 0) {
        unplaced.push({ plan: file, id: acceptance.id, route: planRoute ? `${planRoute.method} ${planRoute.path} (${planRoute.name})` : acceptance.route })
        continue
      }
      const view = acceptance.expect.inertia === undefined ? undefined : plan.views.find((entry) => entry.id === acceptance.expect.inertia)
      for (const owner of owners) {
        features.get(owner)!.acceptance.push({
          plan: file, acceptance,
          route: { method: planRoute.method, path: planRoute.path, name: planRoute.name },
          ...(view ? { page: view.page } : {}),
        })
      }
    }
    for (const view of plan.views) {
      const owner = features.get(featureOfPage({ label: view.page, module: view.module ?? null }))
      owner?.views.push({ plan: file, view })
    }
  }

  const unresolvedRenders = graph.unresolved
    .filter((entry) => entry.relation === 'renders')
    .map((entry) => ({ controller: (entry.from && nodes.get(entry.from)?.label) ?? entry.from ?? '(unknown)', target: entry.target, reason: entry.reason }))

  return {
    complete: gaps.length === 0,
    gaps,
    ...(middlewareGap ? { middlewareGap } : {}),
    features: [...features.values()].filter((entry) => entry.routes.length > 0).sort((a, b) => compare(a.name, b.name)),
    unreached: pages.filter((page) => !reached.has(page.id)).map((page) => page.label).sort(compare),
    unassigned,
    unresolvedRenders,
    unplaced,
    plans: plans.map((entry) => entry.file).sort(compare),
    unreadablePlans,
  }
}

const SECTION_HEADINGS = { routes: 'Routes', reach: 'How to reach it', plan: 'Plan', index: 'Features' } as const
type GeneratedSection = keyof typeof SECTION_HEADINGS

const BROWSER_MARKERS: MarkerSyntax = {
  name: 'guren:browser',
  open(line) {
    const match = /^<!-- guren:browser (\S+) -->$/u.exec(line)
    return match ? { key: match[1]!, match } : undefined
  },
  close(line) {
    return /^<!-- \/guren:browser (\S+) -->$/u.exec(line)?.[1]
  },
}

function code(value: string): string {
  return `\`${value.replace(/`/gu, "'")}\``
}

function cell(value: string): string {
  return value.replace(/\|/gu, '\\|')
}

function routesBlock(feature: BrowserFeature): string[] {
  return [
    '| Method | Path | Name | Middleware | Page |',
    '| --- | --- | --- | --- | --- |',
    ...feature.routes.map((route) => `| ${route.method} | ${cell(route.path)} | ${cell(route.name ?? '')} | ${cell(route.middleware.join(', '))} | ${cell(route.pages.join(', '))} |`),
  ]
}

function reachBlock(feature: BrowserFeature, map: BrowserMap): string[] {
  const lines: string[] = []
  const { landmark } = feature
  if (landmark) {
    const label = `${code(`${landmark.method} ${landmark.path}`)}${landmark.name ? ` (${landmark.name})` : ''}`
    lines.push(`Landmark: ${label}, rendering ${landmark.pages.map(code).join(' or ')}.`)
    lines.push(landmark.middleware.length > 0 ? `Middleware on the landmark: ${landmark.middleware.map(code).join(', ')}.` : 'No middleware on the landmark.')
  } else {
    lines.push('No landmark: every route rendering this feature takes a path parameter.')
  }
  const guarded = feature.routes.filter((route) => route.middleware.length > 0 && route !== landmark)
  if (guarded.length > 0) {
    lines.push('', 'Other routes with middleware:')
    for (const route of guarded) lines.push(`- ${code(`${route.method} ${route.path}`)}: ${route.middleware.map(code).join(', ')}`)
  }
  if (map.middlewareGap) lines.push('', `Middleware lists may be incomplete: ${map.middlewareGap.reasons.join('; ')}`)
  return lines
}

function jsonValues(values: PlanAcceptance['input']): string {
  return (values ?? []).map((value) => `${value.name}: ${value.json}`).join(', ')
}

function acceptanceLines(entry: BrowserMapAcceptance): string[] {
  const { acceptance, route } = entry
  const { expect } = acceptance
  const lines = [`**${acceptance.id}** (${acceptance.kind}): ${acceptance.description}`, `- Actor: ${acceptance.actor}`]
  if (acceptance.given.length > 0) lines.push(`- Given: ${acceptance.given.join('; ')}`)
  const target = `${code(route.name)} (${route.method} ${route.path})`
  const input = jsonValues(acceptance.input)
  lines.push(route.method === 'GET' ? `- Request ${target}${input ? ` with ${input}` : ''}` : `- Submit to ${target}${input ? ` with ${input}` : ''}`)
  const outcome: string[] = []
  if (expect.status !== undefined) outcome.push(`status ${expect.status}`)
  if (expect.redirect !== undefined) outcome.push(`redirect to ${code(expect.redirect)}`)
  if (entry.page !== undefined) outcome.push(`page ${code(entry.page)}`)
  if (outcome.length > 0) lines.push(`- Expect ${outcome.join(', ')}`)
  if (expect.errors && expect.errors.length > 0) lines.push(`- An error shown on field ${expect.errors.map(code).join(', ')} (message text not planned)`)
  for (const row of expect.database ?? []) {
    const parts = [row.has && row.has.length > 0 ? `has ${jsonValues(row.has)}` : '', row.missing && row.missing.length > 0 ? `missing ${jsonValues(row.missing)}` : ''].filter(Boolean)
    lines.push(`- Rows: ${code(row.table)} ${parts.join('; ')}`)
  }
  return lines
}

function viewLines(entry: BrowserMapView): string[] {
  const { view } = entry
  const lines = [`Locators (view ${code(view.id)}, page ${code(view.page)}):`]
  for (const field of view.form?.fields ?? []) lines.push(`- field ${code(field.field)} (${field.input}), label "${field.label}"`)
  for (const action of view.actions) lines.push(`- action "${action.label}" to ${code(action.route)} (button or link: check the page)`)
  const states = Object.entries(view.states).filter(([, value]) => value !== undefined && value !== '')
  if (states.length > 0) lines.push(`- States to reach: ${states.map(([state, value]) => `${state} "${value}"`).join('; ')}`)
  return lines
}

function planBlock(feature: BrowserFeature): string[] {
  const plans = [...new Set([...feature.acceptance.map((entry) => entry.plan), ...feature.views.map((entry) => entry.plan)])].sort(compare)
  if (plans.length === 0) return ['None: no approved plan covers these routes. Outcomes are not inferred from names.']
  const lines: string[] = []
  for (const plan of plans) {
    if (lines.length > 0) lines.push('')
    lines.push(`From ${code(plan)}. Planned: confirm on the live page before a spec relies on it.`)
    for (const entry of feature.acceptance.filter((item) => item.plan === plan)) lines.push('', ...acceptanceLines(entry))
    for (const entry of feature.views.filter((item) => item.plan === plan)) lines.push('', ...viewLines(entry))
  }
  return lines
}

const CHARTER_BY_KIND: Record<PlanAcceptance['kind'], string> = {
  success: 'complete the flow, reload, and confirm the result is still there',
  validation: 'submit what the plan rejects, then values just past each rule',
  unauthenticated: 'reach the same routes signed out',
  forbidden: 'act as an account the plan forbids',
  'not-found': 'request what the plan expects to be missing, and ids just beyond it',
  state: 'drive the page into the planned state, then every other state it lists',
}

function seededCharters(feature: BrowserFeature): string[] {
  const kinds = new Map<PlanAcceptance['kind'], string[]>()
  for (const { acceptance } of feature.acceptance) kinds.set(acceptance.kind, [...(kinds.get(acceptance.kind) ?? []), acceptance.id])
  if (kinds.size === 0) return ['One line per area to explore: one area, one posture, one sentence.']
  return [...kinds].map(([kind, ids]) => `- ${kind} (${ids.join(', ')}): ${CHARTER_BY_KIND[kind]}`)
}

function generatedBlocks(feature: BrowserFeature, map: BrowserMap): Array<[GeneratedSection, string[]]> {
  return [['routes', routesBlock(feature)], ['reach', reachBlock(feature, map)], ['plan', planBlock(feature)]]
}

function block(section: GeneratedSection, content: readonly string[]): string[] {
  return [`<!-- guren:browser ${section} -->`, ...content, `<!-- /guren:browser ${section} -->`]
}

function frontmatter(entities: readonly string[]): string[] {
  return ['---', 'type: browser', ...(entities.length > 0 ? [`entities: [${entities.join(', ')}]`] : []), `generated: { by: ${BROWSER_MAP_ACTOR} }`, '---']
}

function newFeatureDoc(feature: BrowserFeature, map: BrowserMap): string {
  const lines = [...frontmatter(feature.entities), '', `# ${feature.name}`, '']
  for (const [section, content] of generatedBlocks(feature, map)) lines.push(`## ${SECTION_HEADINGS[section]}`, '', ...block(section, content), '')
  lines.push('## Charters', '', ...seededCharters(feature), '', '## Gotchas', '', 'What reads as broken here but is not, and what the local app cannot do.', '')
  return lines.join('\n')
}

/** The block replaced where it exists; otherwise inserted after its heading, or appended under a new one. */
function splice(doc: MarkedLines, section: GeneratedSection, content: readonly string[]): string[] {
  const { lines } = doc
  const fenced = block(section, content)
  const existing = doc.blocks.get(section)
  if (existing) return [...lines.slice(0, existing.open), ...fenced, ...lines.slice(existing.close + 1)]
  const heading = findHeadingLine(doc, 2, new Set([SECTION_HEADINGS[section]]))
  if (heading === -1) {
    let end = lines.length
    while (end > 0 && lines[end - 1] === '') end--
    return [...lines.slice(0, end), '', `## ${SECTION_HEADINGS[section]}`, '', ...fenced, '']
  }
  const rest = lines.slice(heading + 1)
  return [...lines.slice(0, heading + 1), '', ...fenced, ...(rest[0] === '' ? rest : ['', ...rest])]
}

function rewrite(document: string, blocks: Array<[GeneratedSection, string[]]>): { content: string } | { problems: string[] } {
  let text = document
  for (const [section, content] of blocks) {
    const { doc, problems } = readMarkedLines(text, BROWSER_MARKERS)
    if (problems.length > 0) return { problems }
    text = splice(doc, section, content).join(doc.eol)
  }
  return { content: text }
}

/** A feature document: created whole, or only its generated blocks rewritten; frontmatter and author text are never touched. */
export function renderFeatureDoc(existing: string | undefined, feature: BrowserFeature, map: BrowserMap): { content: string } | { problems: string[] } {
  if (existing === undefined) return { content: newFeatureDoc(feature, map) }
  return rewrite(existing, generatedBlocks(feature, map))
}

function indexBlock(map: BrowserMap, orphans: readonly string[]): string[] {
  const lines: string[] = []
  if (!map.complete) {
    lines.push('The feature set may be incomplete:')
    for (const gap of map.gaps) lines.push(`- ${gap.section}: ${gap.reasons.join('; ') || 'not complete'}`)
    lines.push('')
  }
  lines.push('| Feature | Landmark | Routes | Pages | Plan |', '| --- | --- | --- | --- | --- |')
  for (const feature of map.features) {
    const landmark = feature.landmark ? `${feature.landmark.method} ${feature.landmark.path}` : 'none'
    const plan = feature.acceptance.length > 0 || feature.views.length > 0 ? 'yes' : 'none'
    lines.push(`| [${cell(feature.name)}](./${posix.basename(feature.file)}) | ${cell(landmark)} | ${feature.routes.length} | ${feature.pages.length} | ${plan} |`)
  }
  const list = (title: string, entries: string[]): void => {
    if (entries.length === 0) return
    lines.push('', title, '', ...entries.map((entry) => `- ${entry}`))
  }
  list('Pages no route renders:', map.unreached.map(code))
  list('Routes in no feature:', map.unassigned.map((route) => `${code(`${route.method} ${route.path}`)}${route.name ? ` (${route.name})` : ''}: ${route.reason}${route.candidates.length > 0 ? ` Candidates: ${route.candidates.join(', ')}.` : ''}`))
  list('Renders the graph could not resolve:', map.unresolvedRenders.map((entry) => `${entry.controller} renders ${code(entry.target)}: ${entry.reason}`))
  list('Acceptance whose route the app does not register yet:', map.unplaced.map((entry) => `${entry.id} in ${code(entry.plan)}: ${entry.route}`))
  list('Plans that could not be read:', map.unreadablePlans.map((entry) => `${code(entry.plan)}: ${entry.reason}`))
  list('Documents with no feature any more (kept, since they hold author text):', orphans.map((file) => code(file)))
  return lines
}

export function renderIndexDoc(existing: string | undefined, map: BrowserMap, orphans: readonly string[]): { content: string } | { problems: string[] } {
  const content = indexBlock(map, orphans)
  if (existing === undefined) {
    return { content: [...frontmatter([]), '', '# Browser verification map', '', 'Generated by `guren browser:map` (RFC 0033). Text outside the `guren:browser` markers is yours and is kept.', '', `## ${SECTION_HEADINGS.index}`, '', ...block('index', content), ''].join('\n') }
  }
  return rewrite(existing, [['index', content]])
}
