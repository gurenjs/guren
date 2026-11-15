/**
 * `REVIEW.md` (RFC 0040 §7): the author's rules for a reviewer, and one block between
 * `<!-- guren:review generated -->` markers that `guren change:policy` keeps: what is always read
 * by a person, the models with sensitive columns, the routes that change data with what authorizes
 * them, and the routes agents can call, read from the Application Graph and the introspected app.
 */
import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { controllerActionSource, type GurenApplicationGraph } from '../application-graph'
import { escapeMarkdownTableCell } from '../docs-links'
import { describeMethod } from '../http-methods'
import { readMarkedLines, spliceMarkedBlock, type MarkerSyntax } from '../marker-blocks'
import { writeFileAtomic } from '../plan/beside'
import { FACT_CLASSES, type FactCode, type Lane } from './fact-classes'
import { GATE_FILES, GATE_PREFIXES } from './lane'
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
  'gate-input': `what the gate, the harness or the reviewer runs or reads: ${[...GATE_FILES].sort().map((file) => `\`${file}\``).join(', ')}, everything under ${GATE_PREFIXES.map((prefix) => `\`${prefix}\``).join(', ')}, the \`package.json\` scripts and every file a script names`,
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
}

export interface ReviewRoute {
  method: string
  path: string
  name?: string
  action?: string
  middleware: string[]
  authentication?: 'required' | 'guest-only'
  /** Policies the action or its middleware names; `<Policy> (through the gate)` for one paired by name only. */
  authorizes: string[]
  /** Why what authorizes the action could not be read: an inline handler, a controller the graph did not resolve. */
  unread?: string
}

export interface ReviewFacts {
  policy: { paths: { high: string[]; medium: string[] }; facts: Array<[string, Lane]> } | { unreadable: string } | undefined
  models: { sensitive: Array<{ model: string; file: string; columns: string[] }>; unread: Array<{ model: string; file: string; reason: string }> }
  routes: ReviewRoute[]
  tools: Array<{ tool: string; method: string; path: string; readOnly: boolean; destructive: boolean; ability?: string }>
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

  lines.push('', '**Routes that change data**, with the middleware they pass through and what authorizes them. A route with no policy and no authorization middleware is one to read for who may call it.', '')
  if (facts.routes.length === 0) lines.push('None found.')
  else {
    lines.push('| Method | Path | Name | Action | Middleware | Signed in | Authorizes |', '| --- | --- | --- | --- | --- | --- | --- |')
    for (const route of facts.routes) {
      const signedIn = route.authentication === 'required' ? 'required' : route.authentication === 'guest-only' ? 'guests only' : 'none declared'
      const authorizes = [...route.authorizes, ...(route.unread ? [`not read (${route.unread})`] : [])].join(', ') || 'none found'
      lines.push(`| ${route.method} | ${cell(route.path)} | ${cell(route.name ?? '')} | ${cell(route.action ?? '')} | ${cell(route.middleware.join(', '))} | ${signedIn} | ${cell(authorizes)} |`)
    }
  }

  lines.push('', '**Routes agents can call** (`.agent()`, exposed as MCP tools): a tool that is not read-only acts for whoever holds the token.', '')
  if (facts.tools.length === 0) lines.push('None.')
  else {
    lines.push('| Tool | Route | Read-only | Destructive | Ability |', '| --- | --- | --- | --- | --- |')
    for (const tool of facts.tools) lines.push(`| ${cell(tool.tool)} | ${cell(`${tool.method} ${tool.path}`)} | ${tool.readOnly ? 'yes' : 'no'} | ${tool.destructive ? 'yes' : 'no'} | ${cell(tool.ability ?? 'not derivable')} |`)
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

/** A new document, or the existing one with only its generated block replaced; text outside the markers is the author's. */
export function renderReviewDoc(existing: string | undefined, content: readonly string[]): { content: string } | { problems: string[] } {
  if (existing === undefined) {
    return checked([
      '# Review',
      '',
      'What a reviewer of this repository checks. Claude Code Review reads this file. Write the rules for this codebase under Rules, and keep each one to a line a reviewer can act on.',
      '',
      '## Rules',
      '',
      '- A change to authentication, authorization or a policy is read for who may now do what.',
      '',
      `## ${SECTION}`,
      '',
      ...fenced(content),
      '',
    ].join('\n'))
  }
  const { doc, problems } = readMarkedLines(existing, REVIEW_MARKERS)
  if (problems.length > 0) return { problems }
  return checked(spliceMarkedBlock(doc, BLOCK, fenced(content), { headings: new Set([SECTION]), newHeading: SECTION }).join(doc.eol))
}

/** The working tree's policy, for the block; the lane reads the merge base's. */
export async function readPolicySummary(cwd: string): Promise<ReviewFacts['policy']> {
  const source = await readFile(join(cwd, REVIEW_POLICY_FILE), 'utf8').catch(() => undefined)
  if (source === undefined) return undefined
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
    loadApplicationGraph({ cwd, introspect: true }).catch((error: unknown) => ({ unreadable: why(error) })),
    readModels(cwd, skippedModels).catch((error: unknown) => ({ unreadable: why(error) })),
    // A run of its own: the memoised one would answer a second call in this process from the first.
    introspectApp(cwd, { fresh: true }),
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
  const sensitive: ReviewFacts['models']['sensitive'] = []
  for (const entry of [...models].sort((a, b) => a.model.file.localeCompare(b.model.file))) {
    const reason = entry.columns === null ? 'its table was not found in a schema the reader parses'
      : entry.opaqueColumns ? 'its table builds columns the reader does not follow'
        : entry.hidden === 'unreadable' ? '`hidden` is not a list written in place' : undefined
    if (reason) unreadModels.push({ model: entry.model.className, file: entry.model.file, reason })
    const columns = [...new Set([...(entry.columns ?? []), ...(Array.isArray(entry.hidden) ? entry.hidden : [])])].filter((column) => sensitiveIn(entry, column))
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
      tools: derived.tools.map((tool) => ({
        tool: tool.toolName, method: tool.method, path: tool.path, readOnly: tool.annotations.readOnlyHint, destructive: tool.annotations.destructiveHint,
        ...(tool.authorization ? { ability: tool.authorization.ability } : {}),
      })),
      gaps: reviewGraphGaps(graph),
    },
  }
}

export type ReviewDocResult =
  | { state: 'written' | 'unchanged' | 'stale' | 'missing'; file: string; gaps: string[] }
  | { state: 'refused'; file: string; problems: string[] }
  | { state: 'unreadable'; file: string; reasons: string[] }

/** `REVIEW.md` at the application root, its block regenerated; under `check` nothing is written. */
export async function syncReviewDoc(cwd: string, options: { check?: boolean; facts?: ReviewFacts } = {}): Promise<ReviewDocResult> {
  const file = join(cwd, REVIEW_DOC_FILE)
  const loaded = options.facts ? { facts: options.facts } : await loadReviewFacts(cwd)
  if ('unreadable' in loaded) return { state: 'unreadable', file, reasons: loaded.unreadable }
  const existing = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const rendered = renderReviewDoc(existing, buildReviewBlock(loaded.facts))
  if ('problems' in rendered) return { state: 'refused', file, problems: rendered.problems }
  if (rendered.content === existing) return { state: 'unchanged', file, gaps: loaded.facts.gaps }
  if (options.check) return { state: existing === undefined ? 'missing' : 'stale', file, gaps: loaded.facts.gaps }
  await writeFileAtomic(file, rendered.content)
  return { state: 'written', file, gaps: loaded.facts.gaps }
}
