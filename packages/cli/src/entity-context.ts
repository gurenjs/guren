import { resolve, basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { ClassDeclaration } from '@babel/types'
import { consola } from 'consola'
import {
  discoverControllerFiles,
  discoverResourceFiles,
  discoverPolicyFiles,
  discoverTestFiles,
  listAppRoots,
  classNameFromPath,
  discoverDbArtifactFiles,
  toPosixRelative,
  moduleNameFromRelPath,
  dbArtifactPattern,
  type DbArtifactKind,
} from './discovery'
import {
  extractClassDeclaration,
  discoverParsedModels,
  type DiscoveredModel,
  type ModelAttachmentCollection,
  type ModelRelationship,
} from './model-parser'
import { classActionMembers } from './controller-methods'
import { loadRouteDefinitions, resolveRoutesFile } from './load-routes'
import { parseSourceFile } from './parse-cache'
import {
  routeDefinitionToContextRoute,
  escapeMarkdownTableCell,
  type ContextRoute,
} from './context-route'
import { extractInertiaPageRefs, describeInertiaPage } from './inertia-pages'
import { scanDocs, extractDocsTags, buildEntityDocIndex, type DocRef } from './docs-index'
import { describeIssue, resolveOriginRepo, type IssueLink } from './issue-refs'
import { parseSchemaTableColumns } from './schema-parser'

export interface EntityPage {
  id: string
  /** Component file relative to the app root; absent when the referenced page has no file. */
  filePath?: string
  props?: string
}

/**
 * The most recent of a set of ISO 8601 timestamps, compared as instants: OKF
 * permits offsets, so `2026-01-01T00:00:00+09:00` is earlier than
 * `2025-12-31T16:00:00Z` despite sorting after it.
 */
function latestTimestamp(values: string[]): string | undefined {
  let latest: string | undefined
  let latestAt = Number.NEGATIVE_INFINITY

  for (const value of values) {
    const at = Date.parse(value)
    const rank = Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at
    if (latest === undefined || rank > latestAt) {
      latest = value
      latestAt = rank
    }
  }
  return latest
}

export interface EntityDoc {
  path: string
  title?: string
  /** OKF `type` (adr, context, guide, spec, …). */
  type?: string
  status?: string
  description?: string
  /** OKF `generated.at` — when the content last meaningfully changed. */
  generatedAt?: string
  /** Latest OKF `verified[].at`, when the doc records verification events. */
  verifiedAt?: string
}

/**
 * A GitHub issue/PR the entity's linked docs declare (RFC 0018). Offline by
 * construction: what the frontmatter says, never what GitHub says.
 */
export interface EntityIssue extends IssueLink {
  /** `owner/repo`, declared or resolved from the `origin` remote; absent for a URL entry. */
  repo?: string
  number?: number
  /** Docs that declared it. */
  docs: string[]
}

export interface EntityContext {
  entity: string
  /** Module the model lives in (RFC 0002), or undefined for the app root. */
  module?: string
  model: {
    filePath: string
    tableName?: string
    columns?: string[]
    relationships: ModelRelationship[]
    /** Attachment collections declared via `Attachable(...)` (RFC 0013). */
    attachments: ModelAttachmentCollection[]
    /** True when `Attachable(...)` is present but its declaration could not be statically read. */
    attachmentsUnreadable: boolean
    usesAuth: boolean
    hasSoftDeletes: boolean
  }
  /** Reverse relationship edges: other models whose relationships target this entity. */
  referencedBy: Array<{ model: string; relationship: string; type: string }>
  routes: ContextRoute[]
  /** Why the routes file could not be loaded, when it could not be. */
  routesError?: string
  controller?: { className: string; filePath: string; actions: string[] }
  pages: EntityPage[]
  resource?: string
  policy?: string
  factories: string[]
  seeders: string[]
  tests: string[]
  /** Docs linked via frontmatter `entities:` or code-side `@docs` tags. */
  docs: EntityDoc[]
  /** Issues those docs declare, de-duplicated across docs (RFC 0018). */
  issues: EntityIssue[]
}

export interface EntityContextOptions {
  cwd?: string
  module?: string
  routesFile?: string
  json?: boolean
}

/**
 * Thrown when the entity argument resolves to no model or to more than one.
 * The CLI and the MCP tool both surface `message` verbatim.
 */
export class EntityResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EntityResolutionError'
  }
}

function resolveEntity(
  entityName: string,
  sameName: DiscoveredModel[],
  allModels: DiscoveredModel[],
  moduleFilter?: string,
): DiscoveredModel {
  // `--module app` selects the application root — the label the ambiguity
  // error uses for it — since root models have no module name of their own.
  const matches = moduleFilter
    ? sameName.filter((m) => (m.module ?? 'app') === moduleFilter)
    : sameName

  if (matches.length === 0) {
    const available = allModels.map((m) => m.info.className).sort()
    throw new EntityResolutionError(
      `Model "${entityName}" not found${moduleFilter ? ` in module "${moduleFilter}"` : ''}.`
        + (available.length > 0 ? ` Available models: ${available.join(', ')}` : ' No models discovered.'),
    )
  }

  if (matches.length > 1) {
    const locations = matches.map((m) => m.module ?? 'app').sort()
    throw new EntityResolutionError(
      `Model "${entityName}" exists in multiple locations: ${locations.join(', ')}. Pass --module <name> to disambiguate.`,
    )
  }

  return matches[0]
}

/**
 * Action names a route may dispatch to: public, instance-level, written as
 * either a method or a function-valued class field. `Router` accepts both, so
 * listing only methods drops a field action silently.
 */
function publicActionNames(classDecl: ClassDeclaration): string[] {
  const actions: string[] = []
  for (const { member, name } of classActionMembers(classDecl)) {
    if (name === 'constructor') continue
    if (member.accessibility === 'private' || member.accessibility === 'protected') continue
    if (member.static) continue
    actions.push(name)
  }
  return actions
}

/**
 * Public method names of the controller class in a source file. Exported
 * classes win over unexported helpers declared alongside them.
 */
function extractControllerActions(source: string, filePath: string): string[] {
  const ast = parseSourceFile(source, filePath)
  if (!ast) return []

  let unexported: ClassDeclaration | null = null
  for (const node of ast.program.body) {
    const classDecl = extractClassDeclaration(node)
    if (!classDecl) continue
    if (node.type !== 'ClassDeclaration') {
      return publicActionNames(classDecl)
    }
    unexported ??= classDecl
  }

  return unexported ? publicActionNames(unexported) : []
}

async function resolvePages(cwd: string, pageIds: string[]): Promise<EntityPage[]> {
  return Promise.all([...pageIds].sort().map((id) => describeInertiaPage(cwd, id)))
}

export async function generateEntityContext(
  entityName: string,
  options: EntityContextOptions = {},
): Promise<EntityContext> {
  const cwd = resolve(options.cwd ?? process.cwd())

  const models = await discoverParsedModels(cwd)
  const lower = entityName.toLowerCase()
  const sameName = models.filter((m) => m.info.className.toLowerCase() === lower)
  const match = resolveEntity(entityName, sameName, models, options.module)
  const entity = match.info.className
  const controllerName = `${entity}Controller`

  // When the same class name exists in more than one location, every join below
  // is restricted to the selected one, or the sibling entity's artifacts leak in.
  const duplicated = sameName.length > 1
  const locationOf = (file: string) => moduleNameFromRelPath(toPosixRelative(cwd, file))
  const inLocation = (file: string) => locationOf(file) === match.module

  const findComponent = async (
    discover: (root: string) => Promise<string[]>,
    className: string,
  ): Promise<string | undefined> => {
    let files = (await discover(cwd)).filter((file) => classNameFromPath(file) === className)
    if (duplicated) files = files.filter(inLocation)
    const file = files.find(inLocation) ?? files[0]
    return file ? toPosixRelative(cwd, file) : undefined
  }

  const findDbArtifacts = async (kind: DbArtifactKind): Promise<string[]> => {
    let roots = await listAppRoots(cwd)
    if (duplicated) roots = roots.filter((root) => root.module === match.module)

    const filePattern = dbArtifactPattern(entity, kind)
    return (await discoverDbArtifactFiles(cwd, kind, roots))
      .filter((file) => filePattern.test(basename(file)))
      .map((file) => toPosixRelative(cwd, file))
      .sort()
  }

  let routesError: string | undefined
  const loadEntityRoutes = async (): Promise<ContextRoute[]> => {
    const target = await resolveRoutesFile(cwd, options.routesFile)
    if (target.silentlyAbsent) return []

    try {
      const provenance: Array<string | null> = []
      const definitions = await loadRouteDefinitions(
        resolve(cwd, target.path),
        cwd,
        undefined,
        provenance,
      )
      return definitions
        .filter((def, index) => {
          const matchesEntity =
            def.controller?.name === controllerName
            || (def.bindings !== undefined && Object.values(def.bindings).includes(entity))
          if (!matchesEntity) return false
          return duplicated ? provenance[index] === match.module : true
        })
        .map(routeDefinitionToContextRoute)
    } catch (error) {
      // A routes file that cannot be loaded is not a routes file with nothing
      // in it: rendering both as "No routes reference this entity." makes an
      // import failure read as an absence.
      routesError = error instanceof Error ? error.message : String(error)
      return []
    }
  }

  const loadControllerBundle = async (): Promise<{
    controller?: EntityContext['controller']
    pages: EntityPage[]
    docsTags: string[]
  }> => {
    let files = (await discoverControllerFiles(cwd)).filter(
      (file) => classNameFromPath(file) === controllerName,
    )
    if (duplicated) files = files.filter(inLocation)
    const controllerFile = files.find(inLocation) ?? files[0]
    if (!controllerFile) return { pages: [], docsTags: [] }

    const source = await readFile(controllerFile, 'utf-8')
    return {
      controller: {
        className: controllerName,
        filePath: toPosixRelative(cwd, controllerFile),
        actions: extractControllerActions(source, controllerFile),
      },
      pages: await resolvePages(
        cwd,
        extractInertiaPageRefs(source).map((ref) => ref.id),
      ),
      docsTags: extractDocsTags(source),
    }
  }

  const loadColumns = async (): Promise<string[] | undefined> => {
    if (!match.info.tableName) return undefined
    const tables = await parseSchemaTableColumns(cwd)
    return tables?.get(match.info.tableName)
  }

  const [columns, routes, controllerBundle, resource, policy, factories, seeders, testFiles, allDocRefs] =
    await Promise.all([
      loadColumns(),
      loadEntityRoutes(),
      loadControllerBundle(),
      findComponent(discoverResourceFiles, `${entity}Resource`),
      findComponent(discoverPolicyFiles, `${entity}Policy`),
      findDbArtifacts('Factory'),
      findDbArtifacts('Seeder'),
      discoverTestFiles(cwd),
      scanDocs(cwd),
    ])

  const referencedBy = models
    .filter((m) => m !== match)
    .flatMap((m) =>
      m.info.relationships
        .filter((rel) => rel.relatedModel === entity)
        .map((rel) => ({ model: m.info.className, relationship: rel.name, type: rel.type })),
    )
    .sort((a, b) => a.model.localeCompare(b.model) || a.relationship.localeCompare(b.relationship))

  const tests = testFiles
    .filter((file) => basename(file).includes(entity))
    .filter((file) => !duplicated || inLocation(file))
    .map((file) => toPosixRelative(cwd, file))
    .sort()

  // Frontmatter `entities:` is location-scoped when the name is duplicated;
  // `@docs` tags cross scope on purpose — they are declared, not inferred.
  const scopedDocRefs = duplicated ? allDocRefs.filter((ref) => ref.module === match.module) : allDocRefs
  const docRefByPath = new Map(allDocRefs.map((ref) => [ref.path, ref] as const))
  const linkedPaths = new Set([
    ...(buildEntityDocIndex(scopedDocRefs).get(lower) ?? []).map((ref) => ref.path),
    ...match.info.docsTags,
    ...controllerBundle.docsTags,
  ])
  const docs = [...linkedPaths]
    .sort((a, b) => a.localeCompare(b))
    .map((path): EntityDoc => {
      const ref = docRefByPath.get(path)
      if (!ref) return { path }
      const verifiedAt = latestTimestamp(
        ref.verified.map((event) => event.at).filter((at): at is string => at !== undefined),
      )
      return {
        path,
        title: ref.title,
        type: ref.type,
        status: ref.status,
        description: ref.description,
        generatedAt: ref.generated?.at,
        verifiedAt,
      }
    })

  return {
    entity,
    module: match.module ?? undefined,
    model: {
      filePath: match.relPath,
      tableName: match.info.tableName,
      columns,
      relationships: match.info.relationships,
      attachments: Array.isArray(match.info.attachments) ? match.info.attachments : [],
      attachmentsUnreadable: match.info.attachments === 'unreadable',
      usesAuth: match.info.usesAuth,
      hasSoftDeletes: match.info.hasSoftDeletes,
    },
    referencedBy,
    routes,
    routesError,
    controller: controllerBundle.controller,
    pages: controllerBundle.pages,
    resource,
    policy,
    factories,
    seeders,
    tests,
    docs,
    issues: await collectEntityIssues(cwd, docs.flatMap((doc) => docRefByPath.get(doc.path) ?? [])),
  }
}

/** One entry per distinct issue, each naming every doc that declared it. */
async function collectEntityIssues(cwd: string, refs: DocRef[]): Promise<EntityIssue[]> {
  // The git spawn happens only for an entity whose docs declare something.
  if (!refs.some((ref) => ref.issues.length > 0)) return []

  const originRepo = await resolveOriginRepo(cwd)
  const byLabel = new Map<string, EntityIssue>()
  for (const ref of refs) {
    for (const issue of ref.issues) {
      const link = describeIssue(issue, originRepo)
      const existing = byLabel.get(link.label)
      if (existing) {
        if (!existing.docs.includes(ref.path)) existing.docs.push(ref.path)
        continue
      }
      byLabel.set(link.label, {
        ...link,
        repo: issue.kind === 'github' ? (issue.repo ?? originRepo ?? undefined) : undefined,
        number: issue.kind === 'github' ? issue.number : undefined,
        docs: [ref.path],
      })
    }
  }
  // By repository then number, so the order does not change with whether
  // `origin` resolved, and #7 precedes #412; URL entries follow, by label.
  return [...byLabel.values()].sort(
    (a, b) =>
      Number(a.number === undefined) - Number(b.number === undefined)
      || (a.repo ?? '').localeCompare(b.repo ?? '')
      || (a.number ?? 0) - (b.number ?? 0)
      || a.label.localeCompare(b.label),
  )
}

/**
 * The `## Agent Interfaces` section (RFC 0016 §14): the entity's `.agent()` routes
 * rendered as the tools they become; content-activated, so an entity exposing none
 * contributes no section. Input lists the route's rendered schema strings *as parts*,
 * since the real inputSchema is the derivation layer's merge. Authorization is reported
 * only where derivable, and says so otherwise: a request-time ability must not read as a named one.
 */
function renderAgentInterfaces(routes: ContextRoute[]): string[] {
  const exposed = routes.filter((route) => route.agent)
  if (exposed.length === 0) return []

  const lines: string[] = [`## Agent Interfaces (${exposed.length})`]

  for (const route of exposed) {
    const agent = route.agent!
    const toolName = agent.toolName ?? route.name ?? '(unnamed — cannot become a tool)'
    lines.push('')
    lines.push(`### ${toolName}`)
    lines.push(`- Route: \`${route.method} ${route.path}\``)

    const description = agent.description ?? route.description ?? route.summary
    if (description) lines.push(`- Description: ${description}`)

    const input = (['params', 'query', 'body'] as const)
      .flatMap((part) => (route[part] ? [`${part}: \`${route[part]}\``] : []))
    lines.push(`- Input: ${input.length > 0 ? input.join(' · ') : 'no schema declared'}`)

    const output = route.output ? `\`${route.output}\`` : 'no output schema declared'
    lines.push(`- Output: ${output}`)

    lines.push(`- Authorization: ${describeAuthorization(route)}`)

    const annotations = (['readOnlyHint', 'destructiveHint', 'idempotentHint'] as const)
      .flatMap((hint) => (agent[hint] === undefined ? [] : [`${hint}: ${agent[hint]}`]))
    if (annotations.length > 0) lines.push(`- Annotations: ${annotations.join(', ')}`)

    lines.push(`- Approval: ${agent.approval === 'required' ? 'required' : 'not required'}`)
  }

  lines.push('')
  return lines
}

function describeAuthorization(route: ContextRoute): string {
  const { authorization } = route
  if (!authorization) {
    return route.middleware && route.middleware.length > 0
      ? `none derivable from the middleware chain (${route.middleware.join(', ')})`
      : 'none derivable from the middleware chain'
  }
  if (authorization.ability) return `\`${authorization.ability}\``
  if (authorization.fromMethodMap) {
    return 'enforced; the ability is resolved from the request method at request time'
  }
  return authorization.abilities.length > 0
    ? `enforced (${authorization.abilities.join(', ')}, mode: ${authorization.mode}), no single ability derivable`
    : 'enforced, but no ability is statically derivable'
}

export function renderEntityContextMarkdown(ctx: EntityContext): string {
  const lines: string[] = []

  lines.push(`# ${ctx.entity}${ctx.module ? ` (module: ${ctx.module})` : ''}`)
  lines.push('')

  const table = ctx.model.tableName ? ` (table: \`${ctx.model.tableName}\`)` : ''
  lines.push(`## Model — ${ctx.model.filePath}${table}`)
  const traits: string[] = []
  if (ctx.model.usesAuth) traits.push('Authenticatable')
  if (ctx.model.hasSoftDeletes) traits.push('SoftDeletes')
  if (traits.length > 0) lines.push(`- Traits: ${traits.join(', ')}`)
  if (ctx.model.columns && ctx.model.columns.length > 0) {
    lines.push(`- Columns: ${ctx.model.columns.join(', ')}`)
  }
  for (const rel of ctx.model.relationships) {
    const target = rel.relatedModel ? ` → ${rel.relatedModel}` : ''
    lines.push(`- ${rel.type}: \`${rel.name}\`${target}`)
  }
  for (const collection of ctx.model.attachments) {
    const method = collection.kind === 'one' ? 'hasOneAttached' : 'hasManyAttached'
    const variants = collection.variants.length > 0 ? ` (variants: ${collection.variants.join(', ')})` : ''
    lines.push(`- ${method}: \`${collection.name}\`${variants}`)
  }
  if (ctx.model.attachmentsUnreadable) {
    lines.push('- Attachments: declared via Attachable(...), but not statically readable — the list above omits them.')
  }
  lines.push('')

  if (ctx.referencedBy.length > 0) {
    lines.push(`## Referenced by`)
    for (const ref of ctx.referencedBy) {
      lines.push(`- ${ref.model} — ${ref.type} \`${ref.relationship}\``)
    }
    lines.push('')
  }

  lines.push(`## Routes (${ctx.routes.length})`)
  if (ctx.routes.length > 0) {
    lines.push('| Method | Path | Name | Action | Params | Body |')
    lines.push('|--------|------|------|--------|--------|------|')
    for (const route of ctx.routes) {
      const action = route.controller ? `${route.controller.name}.${route.controller.action}` : ''
      const cells = [route.method, route.path, route.name ?? '', action, route.params ?? '', route.body ?? '']
      lines.push(`| ${cells.map(escapeMarkdownTableCell).join(' | ')} |`)
    }
  } else if (ctx.routesError) {
    lines.push(`Routes could not be read: ${ctx.routesError}`)
    lines.push('This is not the same as the entity having no routes — the list above is incomplete.')
  } else {
    lines.push('No routes reference this entity.')
  }
  lines.push('')

  if (ctx.controller) {
    lines.push(`## Controller — ${ctx.controller.filePath}`)
    lines.push(`- Actions: ${ctx.controller.actions.join(', ') || 'none'}`)
    lines.push('')
  }

  if (ctx.pages.length > 0) {
    lines.push(`## Pages (${ctx.pages.length})`)
    for (const page of ctx.pages) {
      const missing = page.filePath ? '' : ' (page file missing)'
      const props = page.props ? ` — Props: \`${page.props}\`` : ''
      lines.push(`- ${page.id}${missing}${props}`)
    }
    lines.push('')
  }

  if (ctx.resource) {
    lines.push(`## Resource — ${ctx.resource}`)
    lines.push('')
  }
  if (ctx.policy) {
    lines.push(`## Policy — ${ctx.policy}`)
    lines.push('')
  }

  lines.push(...renderAgentInterfaces(ctx.routes))

  const pushList = (title: string, items: string[]): void => {
    if (items.length === 0) return
    lines.push(`## ${title} (${items.length})`)
    for (const item of items) {
      lines.push(`- ${item}`)
    }
    lines.push('')
  }
  pushList('Factories', ctx.factories)
  pushList('Seeders', ctx.seeders)
  pushList('Tests', ctx.tests)

  if (ctx.docs.length > 0) {
    lines.push(`## Linked docs (${ctx.docs.length})`)
    for (const doc of ctx.docs) {
      const meta = [
        doc.type,
        doc.status,
        doc.verifiedAt ? `verified ${doc.verifiedAt}` : undefined,
      ]
        .filter(Boolean)
        .join(', ')
      lines.push(`- ${doc.path}${doc.title ? ` — ${doc.title}` : ''}${meta ? ` (${meta})` : ''}`)
    }
    lines.push('')
  }

  if (ctx.issues.length > 0) {
    lines.push(`## Linked issues (${ctx.issues.length})`)
    lines.push('Declared by the docs above; state and assignees live on GitHub.')
    for (const issue of ctx.issues) {
      lines.push(`- ${issue.label} — ${issue.docs.join(', ')}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

export async function displayEntityContext(
  entityName: string,
  options: EntityContextOptions = {},
): Promise<void> {
  let ctx: EntityContext
  try {
    ctx = await generateEntityContext(entityName, options)
  } catch (error) {
    if (error instanceof EntityResolutionError) {
      consola.error(error.message)
      process.exitCode = 1
      return
    }
    throw error
  }

  if (options.json) {
    console.log(JSON.stringify(ctx, null, 2))
    return
  }

  console.log(renderEntityContextMarkdown(ctx))
}
