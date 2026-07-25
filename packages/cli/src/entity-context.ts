import { resolve, basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parse } from '@babel/parser'
import type { ClassDeclaration } from '@babel/types'
import { consola } from 'consola'
import {
  discoverControllerFiles,
  discoverResourceFiles,
  discoverPolicyFiles,
  discoverTestFiles,
  listAppRoots,
  classNameFromPath,
  collectFiles,
  toPosixRelative,
  moduleNameFromRelPath,
} from './discovery'
import {
  extractClassDeclaration,
  discoverParsedModels,
  type DiscoveredModel,
  type ModelRelationship,
} from './model-parser'
import { loadRouteDefinitions, DEFAULT_ROUTES_FILE } from './load-routes'
import {
  routeDefinitionToContextRoute,
  escapeMarkdownTableCell,
  type ContextRoute,
} from './context-route'
import { extractInertiaPageRefs, describeInertiaPage } from './inertia-pages'
import { scanDocs, extractDocsTags, buildEntityDocIndex } from './docs-index'
import { parseSchemaTableColumns } from './schema-parser'

export interface EntityPage {
  id: string
  /** Component file relative to the app root; absent when the referenced page has no file. */
  filePath?: string
  props?: string
}

export interface EntityDoc {
  path: string
  title?: string
  kind?: string
  status?: string
  lastReviewed?: string
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
    usesAuth: boolean
    hasSoftDeletes: boolean
  }
  /** Reverse relationship edges: other models whose relationships target this entity. */
  referencedBy: Array<{ model: string; relationship: string; type: string }>
  routes: ContextRoute[]
  controller?: { className: string; filePath: string; actions: string[] }
  pages: EntityPage[]
  resource?: string
  policy?: string
  factories: string[]
  seeders: string[]
  tests: string[]
  /** Docs linked via frontmatter `entities:` or code-side `@docs` tags. */
  docs: EntityDoc[]
}

export interface EntityContextOptions {
  cwd?: string
  module?: string
  routesFile?: string
  json?: boolean
}

/**
 * Thrown when the entity argument can't be resolved to exactly one model —
 * unknown name, or the same class name in more than one location. The CLI
 * and the MCP tool both surface `message` verbatim.
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

function publicMethodNames(classDecl: ClassDeclaration): string[] {
  const actions: string[] = []
  for (const member of classDecl.body.body) {
    if (member.type !== 'ClassMethod') continue
    if (member.key.type !== 'Identifier') continue
    if (member.key.name === 'constructor') continue
    if (member.accessibility === 'private' || member.accessibility === 'protected') continue
    if (member.static) continue
    actions.push(member.key.name)
  }
  return actions
}

/**
 * Public method names of the controller class in a source file. Exported
 * classes win over unexported helpers declared alongside them; a bare
 * class is only used when nothing is exported.
 */
function extractControllerActions(source: string): string[] {
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  } catch {
    return []
  }

  let unexported: ClassDeclaration | null = null
  for (const node of ast.program.body) {
    const classDecl = extractClassDeclaration(node)
    if (!classDecl) continue
    if (node.type !== 'ClassDeclaration') {
      return publicMethodNames(classDecl)
    }
    unexported ??= classDecl
  }

  return unexported ? publicMethodNames(unexported) : []
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

  // When the same class name exists in more than one location, every join
  // below is restricted to the selected location — otherwise artifacts of
  // the sibling entity would leak into the bundle.
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

  const findDbArtifacts = async (subDir: string, filePattern: RegExp): Promise<string[]> => {
    let roots = await listAppRoots(cwd)
    if (duplicated) roots = roots.filter((root) => root.module === match.module)

    const groups = await Promise.all(roots.map((root) => collectFiles(resolve(root.dir, subDir))))
    return groups
      .flat()
      .filter((file) => filePattern.test(basename(file)))
      .map((file) => toPosixRelative(cwd, file))
      .sort()
  }

  const loadEntityRoutes = async (): Promise<ContextRoute[]> => {
    try {
      const provenance: Array<string | null> = []
      const definitions = await loadRouteDefinitions(
        resolve(cwd, options.routesFile ?? DEFAULT_ROUTES_FILE),
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
    } catch {
      // Routes may not be loadable (missing deps, etc.) — degrade to a route-less bundle.
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
        actions: extractControllerActions(source),
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
      findDbArtifacts('db/factories', new RegExp(`(?:^|_)${entity}s?Factory\\.`, 'i')),
      findDbArtifacts('db/seeders', new RegExp(`(?:^|_)${entity}s?Seeder\\.`, 'i')),
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

  // Linked docs: frontmatter `entities:` (location-scoped when duplicated)
  // merged with explicit @docs tags from the model and controller sources
  // (tags cross scope on purpose — they are declared, not inferred).
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
      return ref
        ? { path, title: ref.title, kind: ref.kind, status: ref.status, lastReviewed: ref.lastReviewed }
        : { path }
    })

  return {
    entity,
    module: match.module ?? undefined,
    model: {
      filePath: match.relPath,
      tableName: match.info.tableName,
      columns,
      relationships: match.info.relationships,
      usesAuth: match.info.usesAuth,
      hasSoftDeletes: match.info.hasSoftDeletes,
    },
    referencedBy,
    routes,
    controller: controllerBundle.controller,
    pages: controllerBundle.pages,
    resource,
    policy,
    factories,
    seeders,
    tests,
    docs,
  }
}

export function renderEntityContextMarkdown(ctx: EntityContext): string {
  const lines: string[] = []

  lines.push(`# ${ctx.entity}${ctx.module ? ` (module: ${ctx.module})` : ''}`)
  lines.push('')

  // Model
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
  lines.push('')

  if (ctx.referencedBy.length > 0) {
    lines.push(`## Referenced by`)
    for (const ref of ctx.referencedBy) {
      lines.push(`- ${ref.model} — ${ref.type} \`${ref.relationship}\``)
    }
    lines.push('')
  }

  // Routes
  lines.push(`## Routes (${ctx.routes.length})`)
  if (ctx.routes.length > 0) {
    lines.push('| Method | Path | Name | Action | Params | Body |')
    lines.push('|--------|------|------|--------|--------|------|')
    for (const route of ctx.routes) {
      const action = route.controller ? `${route.controller.name}.${route.controller.action}` : ''
      const cells = [route.method, route.path, route.name ?? '', action, route.params ?? '', route.body ?? '']
      lines.push(`| ${cells.map(escapeMarkdownTableCell).join(' | ')} |`)
    }
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
      const meta = [doc.kind, doc.status, doc.lastReviewed ? `reviewed ${doc.lastReviewed}` : undefined]
        .filter(Boolean)
        .join(', ')
      lines.push(`- ${doc.path}${doc.title ? ` — ${doc.title}` : ''}${meta ? ` (${meta})` : ''}`)
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
