/**
 * Payload assembly for the docs viewer endpoint (RFC 0005).
 *
 * `buildDocsViewerData` bundles everything the UI needs into one payload, so
 * the server exposes a whole-bundle route with no path parameters. The one
 * parameterized route, a plan page, looks its slug up among the discovered
 * plans and never joins it into a path.
 */
import { readFileSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseDocFrontmatter } from './docs-frontmatter'
import { localLinkTarget } from './docs-links'
import type { DocActorEvent, DocRef } from './docs-index'
import { describeIssue, type IssueLink } from './issue-refs'
import { resolveOriginRepo } from './github'
import { resolveDocLink } from './docs-check'
import { loadDocsGraph, type DocsGraphEdge, type DocsGraphNode } from './docs-graph'
import { escapeHtml, renderDocHtml } from './docs-render'
import type { AcceptanceTestRef } from './docs-acceptance'
import { planDocClosedHashIn, planDocPath, readPlanBlocks } from './plan/close-docs'
import { renderedPlanHash } from './plan/render'
import { planCommand, readViewerPlans, type DocsViewerOpenPlan } from './docs-viewer-plans'
import { discoverPlanFiles } from './plan-check'
import { planOutputPath } from './plan/beside'
import { planSlug } from './plan/state'
import { fileExists, toPosixRelative } from './discovery'
import { composePage } from './page-bundle'

export type DocTrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed'

/** OKF §5.3: derived from `verified`, keyed off the `human:` actor prefix. */
export function docTrustTier(ref: Pick<DocRef, 'verified'>): DocTrustTier {
  if (ref.verified.length === 0) return 'unverified'
  return ref.verified.some((event) => event.by?.startsWith('human:'))
    ? 'human-reviewed'
    : 'machine-confirmed'
}

export interface DocsViewerDoc {
  path: string
  module: string | null
  title?: string
  type?: string
  status?: string
  description?: string
  tags: string[]
  entities: string[]
  related: string[]
  links: string[]
  generated?: DocActorEvent
  verified: DocActorEvent[]
  staleAfter?: string
  /**
   * Whether `stale_after` has passed, as `guren check --docs` judged it, so the
   * UI does not re-implement the calendar-day rule (a bare `Date.parse` accepts
   * `2026-02-30` and rolls it forward).
   */
  stale: boolean
  trustTier: DocTrustTier
  /** Outlinks for `issues:` (RFC 0018). */
  issues: IssueLink[]
  /** The plan hash a doc `plan:close` wrote says it closed at (RFC 0030 §7). */
  closedPlanHash?: string
  /**
   * Rendered body; the leading H1 is dropped (the panel header carries the title), and each
   * block `plan:close` fenced is a `<section class="plan-block">` naming its plan.
   */
  html: string
}

export interface DocsViewerData {
  nodes: DocsGraphNode[]
  edges: DocsGraphEdge[]
  docs: DocsViewerDoc[]
  /** The test files carrying each acceptance id, for the `test` nodes' panel. */
  tests: AcceptanceTestRef[]
  /** Plans whose page `plan:render` wrote beside them, served at `plans/<slug>`. */
  planPages: DocsViewerPlanPage[]
  /** Every plan not closed at its current hash, with its steps' records (RFC 0030 §7). */
  plans: DocsViewerOpenPlan[]
}

export interface DocsViewerPlanPage {
  slug: string
  /** App-relative POSIX paths: the plan file, its rendered page, and the doc `plan:close` writes for it. */
  plan: string
  page: string
  doc: string
  /** The page carries another hash than the plan's current one; a draft's page is never judged. */
  stale?: boolean
  /** `stale` only: the command that renders it again. */
  render?: string
}

/** A page's embedded hash by path, kept while its mtime holds: a page embeds the whole plan, and the payload is rebuilt on a poll. */
const renderedHashes = new Map<string, { mtimeMs: number; hash: string | null | undefined }>()

/** Stat and read through one handle, so the mtime cached is the mtime of the bytes read. */
async function pageHash(path: string): Promise<string | null | undefined> {
  const handle = await open(path, 'r').catch(() => undefined)
  if (handle === undefined) return undefined
  try {
    const { mtimeMs } = await handle.stat()
    const cached = renderedHashes.get(path)
    if (cached?.mtimeMs === mtimeMs) return cached.hash
    const hash = renderedPlanHash(await handle.readFile('utf-8'))
    renderedHashes.set(path, { mtimeMs, hash })
    return hash
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}

/** Marks each page rendered at another hash than its plan's; one that will not read is left unjudged. */
async function judgePageFreshness(cwd: string, pages: DocsViewerPlanPage[], hashes: ReadonlyMap<string, string | null>): Promise<DocsViewerPlanPage[]> {
  return Promise.all(
    pages.map(async (page) => {
      const current = hashes.get(page.plan)
      if (typeof current !== 'string') return page
      const rendered = await pageHash(resolve(cwd, page.page))
      return rendered === undefined || rendered === current ? page : { ...page, stale: true, render: planCommand('plan:render', page.plan) }
    }),
  )
}

/**
 * Each discovered plan whose page exists where `plan:render` writes it by default; a page
 * written elsewhere with `-o` is not found. Of two plans sharing a slug, the first with a page wins.
 */
async function findPlanPages(cwd: string, files: readonly string[], onlySlug?: string): Promise<DocsViewerPlanPage[]> {
  const candidates = onlySlug === undefined ? files : files.filter((file) => planSlug(file) === onlySlug)
  const found = await Promise.all(
    candidates.map(async (file): Promise<DocsViewerPlanPage | undefined> => {
      const page = planOutputPath(file)
      if (!(await fileExists(cwd, page))) return undefined
      const slug = planSlug(file)
      return { slug, plan: toPosixRelative(cwd, file), page: toPosixRelative(cwd, page), doc: planDocPath(slug) }
    }),
  )
  const bySlug = new Map<string, DocsViewerPlanPage>()
  for (const page of found) if (page && !bySlug.has(page.slug)) bySlug.set(page.slug, page)
  return [...bySlug.values()]
}

/**
 * The rendered page of the plan named `slug`, or `undefined`. The slug is looked up among the
 * discovered plans, never joined into a path, so a request cannot reach another file.
 */
export async function docsViewerPlanPage(cwd: string, slug: string): Promise<string | undefined> {
  const [page] = await findPlanPages(cwd, (await discoverPlanFiles(cwd)).files, slug)
  return page ? readFile(resolve(cwd, page.page), 'utf-8') : undefined
}

/** Both match one character, so neither can backtrack the way a quantifier can. */
const WHITESPACE = /\s/
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

function skipWhitespace(body: string, from: number): number {
  let cursor = from
  while (cursor < body.length && WHITESPACE.test(body[cursor])) cursor += 1
  return cursor
}

/** Whether a `#` heading opens at `at`: a `#` with whitespace behind it. */
function opensHeading(body: string, at: number): boolean {
  return body[at] === '#' && at + 1 < body.length && WHITESPACE.test(body[at + 1])
}

/** Where the heading opening at `at` ends. Only meaningful once it opens one. */
function headingEnd(body: string, at: number): number {
  let cursor = skipWhitespace(body, at + 1)
  while (cursor < body.length && !LINE_TERMINATOR.test(body[cursor])) cursor += 1
  return cursor
}

/**
 * Where the first heading standing behind a comment closed at or after `from`
 * ends, or -1 when none does. Which `<!--` opened the comment never changes the
 * answer, so the search need not know.
 */
function headingBehindComment(body: string, from: number): number {
  for (let closer = body.indexOf('-->', from); closer !== -1; closer = body.indexOf('-->', closer + 3)) {
    const heading = skipWhitespace(body, closer + 3)
    if (opensHeading(body, heading)) return headingEnd(body, heading)
  }

  return -1
}

/**
 * The body without its first H1 and any HTML comment before it (the panel header carries
 * the title). Scanned rather than matched with `/^\s*(?:<!--[\s\S]*?-->\s*)?#\s+.*$/m`, whose
 * lazy comment body is re-scanned from every line start: quadratic on many `<!--`. Two
 * invariants bound visits per character: `headingBehindComment` resolves the heading *end*
 * only for the closer it settles on, at most twice; the line loop resumes at `from`, not `lineStart`.
 */
function stripLeadingH1(body: string): string {
  let noHeadingBehindComments = false
  let lineStart = 0

  for (;;) {
    const from = skipWhitespace(body, lineStart)

    if (!noHeadingBehindComments && body.startsWith('<!--', from)) {
      const end = headingBehindComment(body, from + 4)
      if (end !== -1) return body.slice(0, lineStart) + body.slice(end)
      noHeadingBehindComments = true
    }

    if (opensHeading(body, from)) return body.slice(0, lineStart) + body.slice(headingEnd(body, from))

    // A multiline `^` anchors after every line terminator, `\r` included.
    let cursor = from
    while (cursor < body.length && !LINE_TERMINATOR.test(body[cursor])) cursor += 1
    if (cursor === body.length) return body
    lineStart = cursor + 1
  }
}

/**
 * The graph node id a body link points at. `localLinkTarget` is the same filter
 * `scanDocs` ran to derive the edge, so the rendered target and the node id
 * cannot disagree; anything it rejects keeps its literal text.
 */
function resolveViewerLink(docPath: string, target: string): string {
  const local = localLinkTarget(target)
  if (local === null) return target
  return resolveDocLink(docPath, local) ?? target
}

/**
 * The body as HTML, each `guren:plan` block framed and labelled with the plan doc it came from.
 * Markers `plan:close` would refuse to rewrite leave the body rendered as it is, markers unseen.
 */
function renderViewerBody(docPath: string, body: string): string {
  const render = (text: string): string =>
    renderDocHtml(text, { resolveLink: (target) => resolveViewerLink(docPath, target) })
  // Only a document plan:close wrote into can hold a block; the rest skip the marker scan.
  const read = body.includes('<!-- guren:plan ') ? readPlanBlocks(body) : undefined
  if (!read || read.blocks.length === 0) return render(body)

  const parts: string[] = []
  let from = 0
  for (const block of read.blocks) {
    parts.push(render(read.lines.slice(from, block.open).join('\n')))
    const label =
      `<p class="plan-block-label">plan <a class="md-link" data-target="${escapeHtml(planDocPath(block.slug))}">`
      + `${escapeHtml(block.slug)}</a> <code>${escapeHtml(block.hash.slice(0, 12))}</code></p>`
    const inner = render(read.lines.slice(block.open + 1, block.close).join('\n'))
    parts.push(`<section class="plan-block">${label}\n${inner}</section>`)
    from = block.close + 1
  }
  parts.push(render(read.lines.slice(from).join('\n')))
  return parts.filter((part) => part !== '').join('\n')
}

export async function buildDocsViewerData(cwd: string): Promise<DocsViewerData> {
  const [
    {
      refs,
      checks,
      tests,
      graph: { nodes, edges },
    },
    [pagesFound, plans],
  ] = await Promise.all([
    loadDocsGraph(cwd),
    discoverPlanFiles(cwd).then(({ files }) => Promise.all([findPlanPages(cwd, files), readViewerPlans(cwd, files)])),
  ])
  const planPages = await judgePageFreshness(cwd, pagesFound, plans.hashes)
  const staleDocs = new Set(
    checks.filter((check) => check.key.startsWith('docs-stale:')).map((check) => check.filePath),
  )
  // The git spawn happens only for a bundle that declares something.
  const originRepo = refs.some((ref) => ref.issues.length > 0) ? await resolveOriginRepo(cwd) : null

  const docs = await Promise.all(
    refs.map(async (ref): Promise<DocsViewerDoc> => {
      const source = await readFile(resolve(cwd, ref.path), 'utf-8').catch(() => '')
      const frontmatter = parseDocFrontmatter(source)
      const body = stripLeadingH1(frontmatter?.body ?? source)
      return {
        path: ref.path,
        module: ref.module,
        title: ref.title,
        type: ref.type,
        status: ref.status,
        description: ref.description,
        tags: ref.tags,
        entities: ref.entities,
        related: ref.related,
        links: ref.links,
        generated: ref.generated,
        verified: ref.verified,
        staleAfter: ref.staleAfter,
        stale: staleDocs.has(ref.path),
        trustTier: docTrustTier(ref),
        issues: ref.issues.map((issue) => describeIssue(issue, originRepo)),
        closedPlanHash: ref.type === 'plan' ? planDocClosedHashIn(frontmatter?.data) : undefined,
        // Links carry the app-root path they resolve to, so the viewer
        // navigates by map lookup instead of re-deriving the rules client-side.
        html: renderViewerBody(ref.path, body),
      }
    }),
  )

  return { nodes, edges, docs, tests, planPages, plans: plans.open }
}

/** Where the build writes the composed shell, relative to the package root; `files` ships it. */
export const DOCS_VIEWER_ASSET_DIR = 'assets/docs-viewer'
const DOCS_VIEWER_PAGE = { template: 'index.html', entry: 'main.ts', placeholder: '__GUREN_DOCS_VIEWER_SCRIPT__', what: 'docs viewer' }

/** The template under `pageDir` (`src/docs-viewer-page/`) with its TypeScript bundled in: what the build writes. */
export function composeDocsViewerPage(pageDir: string): string {
  return composePage(pageDir, DOCS_VIEWER_PAGE)
}

/**
 * Absolute path of the shell the build composed. `assets/` sits next to both `src/` and `dist/`,
 * so the relative hop works from source and build alike; from source, prefer {@link docsViewerShell}.
 */
export function docsViewerAssetPath(): string {
  return fileURLToPath(new URL(`../${DOCS_VIEWER_ASSET_DIR}/index.html`, import.meta.url))
}

let shell: string | undefined

/**
 * The viewer's HTML. Run from source, `docs-viewer-page/` sits beside this module and is composed
 * once per process, so nothing reads a build gone stale; the published package ships only the
 * composed file, which is read instead.
 */
export function docsViewerShell(): string {
  if (shell !== undefined) return shell
  try {
    shell = composeDocsViewerPage(fileURLToPath(new URL('./docs-viewer-page/', import.meta.url)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    shell = readFileSync(docsViewerAssetPath(), 'utf8')
  }
  return shell
}
