/**
 * `REVIEW.md` (RFC 0040 §7): the author's rules for a reviewer, and one block between
 * `<!-- guren:review generated -->` markers that `guren change:policy` keeps: what is always read
 * by a person, the models with sensitive columns, the routes that change data with what authorizes
 * them, and the routes agents can call, read from the Application Graph and the introspected app.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

import { controllerActionSource, type GurenApplicationGraph } from '../application-graph'
import { escapeMarkdownTableCell } from '../docs-links'
import { describeMethod } from '../http-methods'
import { readMarkedLines, spliceMarkedBlock, type MarkerSyntax } from '../marker-blocks'
import { writeFileAtomic } from '../plan/beside'
import { FACT_CLASSES, type FactCode, type Lane } from './fact-classes'
import { GATE_BASENAMES, GATE_FILES, GATE_PREFIXES } from './lane'
import { readReviewPolicySource, REVIEW_POLICY_FILE } from './review-policy'

export const REVIEW_DOC_FILE = 'REVIEW.md'
const BLOCK = 'generated'
const SECTION = 'What this application holds'
/** The graph sections the block's tables rest on; one that did not read whole is named in the block. */
const GRAPH_SECTIONS = ['route', 'handles', 'usesMiddleware', 'authorizes', 'model', 'policy'] as const

export const REVIEW_MARKERS: MarkerSyntax<undefined> = {
  name: 'guren:review',
  open(line) {
    const match = /^<!-- guren:review (\S+) -->$/u.exec(line)
    return match ? { key: match[1]!, data: undefined } : undefined
  },
  close(line) {
    return /^<!-- \/guren:review (\S+) -->$/u.exec(line)?.[1]
  },
}

type AlwaysHighCode = { [K in FactCode]: (typeof FACT_CLASSES)[K]['kind'] extends 'always-high' ? K : never }[FactCode]

/** One line per always-high fact; a code added to `FACT_CLASSES` does not compile until it is described here. */
const ALWAYS_HIGH: Record<AlwaysHighCode, string> = {
  'gate-input': `what the gate, the harness or the reviewer runs or reads: ${[...GATE_FILES].sort().map((file) => `\`${file}\``).join(', ')}, any ${[...GATE_BASENAMES].map((file) => `\`${file}\``).join(', ')}, everything under ${GATE_PREFIXES.map((prefix) => `\`${prefix}\``).join(', ')}, the \`package.json\` scripts and every file a script names`,
  'plan-record': 'a plan, its approvals, its decision log or its closing document',
  'migration-destructive': 'an existing migration edited or deleted, or an added one that drops or rewrites data',
  'acceptance-changed': 'a test that carries an acceptance id (`[AC-…]`) edited, or renamed so it no longer carries it',
  'test-removed': 'any test file deleted, or renamed out of what a test run collects',
  'policy-removed': 'a policy deleted, or an ability removed from one',
  'audit-suppressed': 'a new `guren-audit-ignore`, or a change to `config/audit.*`',
  'audit-fail': 'an audit failure the base did not have',
  'sensitive-exposure': 'a sensitive or hidden column newly reaching a response',
  'csrf-exemption': 'a new CSRF exemption',
  'audit-warn-changed': 'a security default switched off, or a policy or forced-write warning on a file the change touches',
  'dependency-advisory': 'a dependency change that brings in an advisory the base did not have',
}

export interface ReviewRoute {
  method: string
  path: string
  name?: string
  action?: string
  middleware: string[]
  authentication?: 'required' | 'guest-only'
  /** Policies the action or its middleware names, which is not proof it enforces one; `<Policy> (through the gate)` for one paired by name only. */
  authorizes: string[]
  /** Why what authorizes the action could not be read: an inline handler, a controller the graph did not resolve. */
  unread?: string
}

export interface ReviewFacts {
  policy: { paths: { high: string[]; medium: string[] }; facts: Array<[string, Lane]> } | { unreadable: string } | undefined
  models: { sensitive: Array<{ model: string; file: string; columns: string[] }>; unread: Array<{ model: string; file: string; reason: string }> }
  routes: ReviewRoute[]
  tools: Array<{ tool: string; method: string; path: string; readOnly: boolean; destructive: boolean; ability?: string; surfaces: string[] }>
  /** Graph sections that did not read whole, each with its reason codes. */
  gaps: string[]
}

const code = (value: string): string => `\`${value.replace(/`/gu, "'")}\``
// GitHub drops an unknown tag such as `<anonymous>`, so angle brackets are written as entities.
const cell = (value: string): string => escapeMarkdownTableCell(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;')

function middlewareLabel(reason: string, target: string): string {
  if (reason.startsWith('Inline middleware')) return `${target} (inline)`
  if (reason.startsWith('No alias or group registers this name')) return `${target} (not registered)`
  return `${target} (unresolved)`
}

/**
 * The mutating routes of the graph, in registration order, each with what authorizes it or why that
 * was not read. `actionsOf` names the methods a controller file's class declares: the graph keeps an
 * `authorizes` edge only for a declared one, so an inherited action would otherwise read as none.
 */
export function reviewRoutes(graph: GurenApplicationGraph, actionsOf?: (file: string, className: string) => ReadonlySet<string> | undefined): ReviewRoute[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const from = (id: string, relation: string) => graph.edges.filter((edge) => edge.from === id && edge.relation === relation)
  const unresolvedFrom = (id: string, relation: string) => graph.unresolved.filter((entry) => entry.from === id && entry.relation === relation)
  const routes: ReviewRoute[] = []
  for (const node of [...graph.nodes].sort((a, b) => (a.route?.order ?? 0) - (b.route?.order ?? 0))) {
    const route = node.route
    if (node.kind !== 'route' || !route || describeMethod(route.method).safe) continue
    const middleware = [
      ...from(node.id, 'usesMiddleware').map((edge) => byId.get(edge.to)?.label ?? edge.to),
      ...unresolvedFrom(node.id, 'usesMiddleware').map((entry) => middlewareLabel(entry.reason, entry.target)),
    ]
    // Route-level authorization middleware is recorded from the route, never resolved to a policy node.
    const authorizes = unresolvedFrom(node.id, 'authorizes').map((entry) => `${entry.target} (middleware)`)
    const controller = from(node.id, 'handles').map((edge) => byId.get(edge.to)).find((target) => target?.kind === 'controller')
    let unread: string | undefined
    const declared = controller?.file === undefined || !actionsOf ? undefined : actionsOf(controller.file, controller.label)
    if (route.action === undefined) unread = 'an inline handler'
    else if (!controller) unread = 'the controller was not resolved'
    else if (controller.file === undefined) unread = 'a controller from a package'
    else if (actionsOf && declared === undefined) unread = 'the controller file was not read'
    else if (declared && !declared.has(route.action)) unread = 'an inherited action, whose body is in a base class'
    else {
      const source = controllerActionSource(route.action)
      for (const edge of from(controller.id, 'authorizes')) {
        if (edge.evidence.some((entry) => entry.source === source)) authorizes.push(byId.get(edge.to)?.label ?? edge.to)
      }
      const key = `${controller.label}.${route.action}`
      for (const entry of unresolvedFrom(controller.id, 'authorizes')) {
        if (!entry.reason.startsWith(`${key} `)) continue
        if (entry.reason.includes('consults the gate')) authorizes.push(`${entry.target === key ? 'a policy' : entry.target} (through the gate)`)
        else authorizes.push(`${entry.target} (import not resolved)`)
      }
    }
    routes.push({
      method: route.method,
      path: route.path,
      ...(route.name ? { name: route.name } : {}),
      ...(route.action !== undefined ? { action: controller ? `${controller.label}.${route.action}` : route.action } : {}),
      middleware: [...new Set(middleware)],
      ...(route.authentication ? { authentication: route.authentication } : {}),
      authorizes: [...new Set(authorizes)],
      ...(unread ? { unread } : {}),
    })
  }
  return routes
}

export function reviewGraphGaps(graph: GurenApplicationGraph): string[] {
  return GRAPH_SECTIONS.flatMap((section) => {
    const coverage = graph.coverage[section]
    if (!coverage || coverage.status === 'complete') return coverage ? [] : [`${section}: not read`]
    return [`${section}: ${[...new Set(coverage.reasons.map((reason) => reason.code))].join(', ') || coverage.status}`]
  })
}

/** The block's lines, markers excluded. Deterministic: the same application gives the same bytes. */
export function buildReviewBlock(facts: ReviewFacts): string[] {
  const lines = [
    'Generated by `guren change:policy`; run it again after a change to routes, policies, models or `guren.review.ts`, and `guren change:policy --check` fails while this block is stale. Edit the rules outside the markers.',
    '',
    '**Read by a person whatever else the change does** (`change:lane` sets these at `high`):',
    '',
    ...Object.values(ALWAYS_HIGH).map((line) => `- ${line}`),
    '- a symlink or a submodule pointer changed, since nothing reads what it points at',
  ]
  const policy = facts.policy
  if (policy && 'unreadable' in policy) lines.push(`- every change, while ${code(REVIEW_POLICY_FILE)} does not read: ${policy.unreadable}`)
  else if (policy) {
    if (policy.paths.high.length > 0) lines.push(`- a path ${code(REVIEW_POLICY_FILE)} puts at \`high\`: ${policy.paths.high.map(code).join(', ')}`)
    if (policy.paths.medium.length > 0) lines.push(`- at \`medium\` at least, by ${code(REVIEW_POLICY_FILE)}: ${policy.paths.medium.map(code).join(', ')}`)
    if (policy.facts.length > 0) lines.push(`- the lanes ${code(REVIEW_POLICY_FILE)} sets: ${policy.facts.map(([fact, lane]) => `${code(fact)} at \`${lane}\``).join(', ')}`)
  }

  lines.push('', '**Models with sensitive columns** (a credential-like name, or `hidden` on the model): a response, a resource or a page that sends one is a finding.', '')
  const { sensitive, unread } = facts.models
  if (sensitive.length === 0) lines.push(unread.length === 0 ? 'None found.' : 'None found among the models read.')
  else lines.push('| Model | File | Columns |', '| --- | --- | --- |', ...sensitive.map((entry) => `| ${cell(entry.model)} | ${cell(entry.file)} | ${cell(entry.columns.join(', '))} |`))
  if (unread.length > 0) lines.push('', 'Not read, so they may hold one:', '', ...unread.map((entry) => `- ${entry.model} (${code(entry.file)}): ${entry.reason}`))

  lines.push('', '**Routes that change data**, with the middleware they pass through and the policies they name. A policy named is not proof it is enforced (an action can construct one and never ask it), so the column says where to look, and a route that names none is one to read for who may call it.', '')
  if (facts.routes.length === 0) lines.push('None found.')
  else {
    lines.push('| Method | Path | Name | Action | Middleware | Signed in | Policies named |', '| --- | --- | --- | --- | --- | --- | --- |')
    for (const route of facts.routes) {
      const signedIn = route.authentication === 'required' ? 'required' : route.authentication === 'guest-only' ? 'guests only' : 'none declared'
      const authorizes = [...route.authorizes, ...(route.unread ? [`not read (${route.unread})`] : [])].join(', ') || 'none found'
      lines.push(`| ${route.method} | ${cell(route.path)} | ${cell(route.name ?? '')} | ${cell(route.action ?? '')} | ${cell(route.middleware.join(', '))} | ${signedIn} | ${cell(authorizes)} |`)
    }
  }

  lines.push('', '**Routes agents can call** (`.agent()`, on the surfaces it is exposed to): a tool that is not read-only acts for whoever holds the token.', '')
  if (facts.tools.length === 0) lines.push('None.')
  else {
    lines.push('| Tool | Route | Exposed to | Read-only | Destructive | Ability |', '| --- | --- | --- | --- | --- | --- |')
    for (const tool of facts.tools) lines.push(`| ${cell(tool.tool)} | ${cell(`${tool.method} ${tool.path}`)} | ${tool.surfaces.join(', ')} | ${tool.readOnly ? 'yes' : 'no'} | ${tool.destructive ? 'yes' : 'no'} | ${cell(tool.ability ?? 'not derivable')} |`)
  }

  if (facts.gaps.length > 0) lines.push('', '**What the tables may be missing**, since the graph did not read these whole:', '', ...facts.gaps.map((gap) => `- ${gap}`))
  return lines
}

function fenced(content: readonly string[]): string[] {
  return [`<!-- guren:review ${BLOCK} -->`, ...content, `<!-- /guren:review ${BLOCK} -->`]
}

function checked(text: string): { content: string } | { problems: string[] } {
  const { problems } = readMarkedLines(text, REVIEW_MARKERS)
  return problems.length > 0 ? { problems } : { content: text }
}

interface DocTemplate {
  title: string
  intro: string
  rules: readonly string[]
}

const REVIEW_TEMPLATE: DocTemplate = {
  title: 'Review',
  intro: 'What a reviewer of this repository checks. Claude Code Review reads this file. Write the rules for this codebase under Rules, and keep each one to a line a reviewer can act on.',
  rules: ['- A change to authentication, authorization or a policy is read for who may now do what.'],
}

const BUGBOT_TEMPLATE: DocTemplate = {
  title: 'Bugbot',
  intro: 'What Cursor Bugbot checks in this repository; it includes this file on every review. Write the rules for this codebase under Rules, and keep each one to a line a reviewer can act on.',
  rules: ['- A change to authentication, authorization or a policy is read for who may now do what.'],
}

function renderDoc(existing: string | undefined, content: readonly string[], template: DocTemplate): { content: string } | { problems: string[] } {
  if (existing === undefined) {
    return checked([`# ${template.title}`, '', template.intro, '', '## Rules', '', ...template.rules, '', `## ${SECTION}`, '', ...fenced(content), ''].join('\n'))
  }
  const { doc, problems } = readMarkedLines(existing, REVIEW_MARKERS)
  if (problems.length > 0) return { problems }
  return checked(spliceMarkedBlock(doc, BLOCK, fenced(content), { headings: new Set([SECTION]), newHeading: SECTION }).join(doc.eol))
}

/** A new document, or the existing one with only its generated block replaced; text outside the markers is the author's. */
export function renderReviewDoc(existing: string | undefined, content: readonly string[]): { content: string } | { problems: string[] } {
  return renderDoc(existing, content, REVIEW_TEMPLATE)
}

/** Bugbot cuts a rule file at 30,000 characters, measured over the whole file, the author's rules included. */
export const BUGBOT_LIMIT = 30_000

/**
 * `.cursor/BUGBOT.md`: the same block, or, where the whole file would pass {@link BUGBOT_LIMIT},
 * what is always read by a person and a pointer to `REVIEW.md` for the tables, since a cut file
 * would end mid-table. A file that passes it even so is refused rather than written to be cut.
 */
export function renderBugbotDoc(existing: string | undefined, content: readonly string[]): { content: string } | { problems: string[] } {
  const full = renderDoc(existing, content, BUGBOT_TEMPLATE)
  if (!('content' in full) || full.content.length <= BUGBOT_LIMIT) return full
  const tables = content.findIndex((line) => line.startsWith('**Models with sensitive columns**'))
  const head = tables === -1 ? content : content.slice(0, tables)
  const cut = renderDoc(existing, [...head, `The tables of what this application holds are in \`${REVIEW_DOC_FILE}\`: with them this file would pass the ${BUGBOT_LIMIT.toLocaleString('en-US')} characters Bugbot reads.`], BUGBOT_TEMPLATE)
  if ('content' in cut && cut.content.length > BUGBOT_LIMIT) {
    return { problems: [`${cut.content.length} characters even without the tables, past the ${BUGBOT_LIMIT.toLocaleString('en-US')} Bugbot reads: shorten the rules outside the markers or the paths in guren.review.ts`] }
  }
  return cut
}

/** The working tree's policy, for the block; the lane reads the merge base's. */
export async function readPolicySummary(cwd: string): Promise<ReviewFacts['policy']> {
  let source: string
  try {
    source = await readFile(join(cwd, REVIEW_POLICY_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return { unreadable: `it could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})` }
  }
  const loaded = readReviewPolicySource(source)
  if (loaded.state !== 'read') return { unreadable: loaded.state === 'unreadable' ? loaded.reason : 'absent' }
  const list = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value])
  return {
    paths: { high: list(loaded.policy.paths?.high), medium: list(loaded.policy.paths?.medium) },
    facts: Object.entries(loaded.policy.facts ?? {}).filter((entry): entry is [string, Lane] => entry[1] !== undefined).sort(([a], [b]) => a.localeCompare(b)),
  }
}

/** The block's facts, or why the application could not be read: a block written from a failed read would read as current. */
export async function loadReviewFacts(cwd: string): Promise<{ facts: ReviewFacts } | { unreadable: string[] }> {
  const [{ loadApplicationGraph }, { readModels, sensitiveIn }, { introspectApp }, { deriveAgentTools }, { parseControllerMethods }] = await Promise.all([
    import('../application-graph-load'), import('../data-exposure-audit'), import('../introspect'), import('@guren/server'), import('../controller-methods'),
  ])
  const skippedModels: string[] = []
  const why = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.replaceAll(`${cwd}${sep}`, '')
  const [graph, models, introspection, policy] = await Promise.all([
    // Without the env files: a machine's git-ignored `.env` must not change the block `--check` compares in CI.
    loadApplicationGraph({ cwd, introspect: true, withoutEnvFiles: true }).catch((error: unknown) => ({ unreadable: why(error) })),
    readModels(cwd, skippedModels).catch((error: unknown) => ({ unreadable: why(error) })),
    introspectApp(cwd, { withoutEnvFiles: true }),
    readPolicySummary(cwd),
  ])
  const unreadable: string[] = []
  if ('unreadable' in graph) unreadable.push(`the application graph: ${graph.unreadable}`)
  else if (graph.coverage.route?.status !== 'complete' && !graph.nodes.some((node) => node.kind === 'route')) {
    unreadable.push(`the routes: ${[...new Set(graph.coverage.route?.reasons.map((reason) => reason.code) ?? [])].join(', ') || 'not registered'}`)
  }
  if ('unreadable' in models) unreadable.push(`the models: ${models.unreadable}`)
  if (introspection.status !== 'ok') unreadable.push(`the agent routes, since the application did not introspect (${introspection.reason}): ${introspection.message.split('\n')[0]!.replaceAll(`${cwd}${sep}`, '')}`)
  if (unreadable.length > 0 || 'unreadable' in graph || 'unreadable' in models || introspection.status !== 'ok') return { unreadable }

  const unreadModels: ReviewFacts['models']['unread'] = skippedModels.sort().map((file) => ({ model: file.split('/').pop()!.replace(/\.[cm]?[jt]sx?$/u, ''), file, reason: 'the file did not parse, or holds no class' }))
  // The model reader reads one class per file; every other model the graph found there is unread.
  const readKeys = new Set(models.map((entry) => `${entry.model.file}#${entry.model.className}`))
  for (const node of graph.nodes) {
    if (node.kind === 'model' && node.file && !readKeys.has(`${node.file}#${node.label}`) && !skippedModels.includes(node.file)) {
      unreadModels.push({ model: node.label, file: node.file, reason: 'not the first class in its file, the one the model reader reads' })
    }
  }
  unreadModels.sort((a, b) => a.file.localeCompare(b.file) || a.model.localeCompare(b.model))
  const sensitive: ReviewFacts['models']['sensitive'] = []
  for (const entry of [...models].sort((a, b) => a.model.file.localeCompare(b.model.file))) {
    const reason = entry.columns === null ? 'its table was not found in a schema the reader parses'
      : entry.opaqueColumns ? 'its table builds columns the reader does not follow'
        : entry.hidden === 'unreadable' ? '`hidden` is not a list written in place'
          : entry.appends === 'unreadable' ? '`appends` is not a list written in place' : undefined
    if (reason) unreadModels.push({ model: entry.model.className, file: entry.model.file, reason })
    // Appended attributes serialize like columns, so a credential-like one is as sensitive.
    const columns = [...new Set([...(entry.columns ?? []), ...(Array.isArray(entry.hidden) ? entry.hidden : []), ...(Array.isArray(entry.appends) ? entry.appends : [])])].filter((column) => sensitiveIn(entry, column))
    if (columns.length > 0) sensitive.push({ model: entry.model.className, file: entry.model.file, columns })
  }
  const scan = await parseControllerMethods(cwd)
  const actionsOf = (file: string, className: string): ReadonlySet<string> | undefined => {
    const declaration = scan.declarations.find((entry) => entry.file === file && entry.className === className)
    return declaration ? new Set(declaration.methods.keys()) : undefined
  }
  // Tools come from the routes the app registered, providers' included, as an adapter derives them; schemas are not needed here.
  const derived = deriveAgentTools(introspection.manifest.routes.map((route) => ({ ...route, schemas: undefined, controller: undefined })) as never)
  return {
    facts: {
      policy,
      models: { sensitive, unread: unreadModels },
      routes: reviewRoutes(graph, actionsOf),
      // An adapter filters on `expose`, so a tool exposed to no surface is not one an agent can call.
      tools: derived.tools.filter((tool) => tool.expose.mcp || tool.expose.webMcp).map((tool) => ({
        tool: tool.toolName, method: tool.method, path: tool.path, readOnly: tool.annotations.readOnlyHint, destructive: tool.annotations.destructiveHint,
        ...(tool.authorization ? { ability: tool.authorization.ability } : {}),
        surfaces: [...(tool.expose.mcp ? ['MCP'] : []), ...(tool.expose.webMcp ? ['WebMCP'] : [])],
      })),
      gaps: reviewGraphGaps(graph),
    },
  }
}

export const BUGBOT_FILE = '.cursor/BUGBOT.md'

export interface ReviewDocFile {
  file: string
  state: 'written' | 'unchanged' | 'stale' | 'missing' | 'refused'
  problems?: string[]
  /** Not written, though it would have been, because another file refused. */
  held?: true
}

export type ReviewDocResult = { state: 'unreadable'; reasons: string[] } | { state: 'read'; files: ReviewDocFile[]; gaps: string[] }

/** Whether the app reviews with Cursor: its agent harness has the Cursor component, the one opt-in `add review` and `change:policy` share. */
export async function reviewsWithCursor(cwd: string): Promise<boolean> {
  const { hasHarnessComponent } = await import('../agent-harness')
  return hasHarnessComponent(cwd, 'cursor')
}

type Planned = { file: ReviewDocFile; path: string; content?: string }

async function planFile(path: string, relative: string, render: (existing: string | undefined) => { content: string } | { problems: string[] }, check: boolean): Promise<Planned> {
  const existing = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const rendered = render(existing)
  if ('problems' in rendered) return { path, file: { file: relative, state: 'refused', problems: rendered.problems } }
  if (rendered.content === existing) return { path, file: { file: relative, state: 'unchanged' } }
  if (check) return { path, file: { file: relative, state: existing === undefined ? 'missing' : 'stale' } }
  return { path, file: { file: relative, state: 'written' }, content: rendered.content }
}

/**
 * `REVIEW.md` at the application root and, for an app that reviews with Cursor, `.cursor/BUGBOT.md`,
 * each with its block regenerated; under `check` nothing is written.
 */
export async function syncReviewDoc(cwd: string, options: { check?: boolean; facts?: ReviewFacts; cursor?: boolean } = {}): Promise<ReviewDocResult> {
  const loaded = options.facts ? { facts: options.facts } : await loadReviewFacts(cwd)
  if ('unreadable' in loaded) return { state: 'unreadable', reasons: loaded.unreadable }
  const block = buildReviewBlock(loaded.facts)
  const check = options.check === true
  const planned = [await planFile(join(cwd, REVIEW_DOC_FILE), REVIEW_DOC_FILE, (existing) => renderReviewDoc(existing, block), check)]
  if (options.cursor ?? await reviewsWithCursor(cwd)) planned.push(await planFile(join(cwd, BUGBOT_FILE), BUGBOT_FILE, (existing) => renderBugbotDoc(existing, block), check))
  // Every file is judged before the first write, so one that refuses leaves the other as it was.
  if (planned.some((entry) => entry.file.state === 'refused')) {
    return { state: 'read', files: planned.map((entry) => (entry.file.state === 'written' ? { file: entry.file.file, state: 'unchanged' as const, held: true } : entry.file)), gaps: loaded.facts.gaps }
  }
  for (const entry of planned) {
    if (entry.content === undefined) continue
    await mkdir(dirname(entry.path), { recursive: true })
    await writeFileAtomic(entry.path, entry.content)
  }
  return { state: 'read', files: planned.map((entry) => entry.file), gaps: loaded.facts.gaps }
}
