import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { parse } from '@babel/parser'
import { consola } from 'consola'
import type { RouteDefinition } from '@guren/core'
import {
  discoverModelFiles,
  discoverControllerFiles,
  discoverResourceFiles,
  discoverPolicyFiles,
  discoverTestFiles,
  listModuleNames,
  classNameFromPath,
  collectFiles,
  toPosixRelative,
  moduleNameFromRelPath,
  fileExists,
} from './discovery'
import { parseModelFile, type ModelInfo, type ModelRelationship } from './model-parser'
import { loadRouteDefinitions } from './load-routes'
import { schemaToTypeString } from './schema-type-extractor'
import { extractPageProps } from './page-props-extractor'
import { parseSchemaTableColumns } from './audit'

const DEFAULT_ROUTES_FILE = 'routes/web.ts'

/**
 * Serializable route view shared by the whole-project context and the
 * entity bundle: `RouteDefinition` with its live Zod schema objects
 * replaced by rendered type strings, so `--json` output stays clean.
 */
export interface ContextRoute {
  method: string
  path: string
  name?: string
  controller?: { name: string; action: string }
  bindings?: Record<string, string>
  middleware?: string[]
  params?: string
  query?: string
  body?: string
  output?: string
}

export interface EntityPage {
  id: string
  filePath: string
  props?: string
}

export interface EntityFileRef {
  className: string
  filePath: string
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
  resource?: EntityFileRef
  policy?: EntityFileRef
  seeders: string[]
  tests: string[]
}

export interface EntityContextOptions {
  cwd?: string
  module?: string
  routesFile?: string
  json?: boolean
}

/**
 * Thrown when the entity argument can't be resolved to exactly one model —
 * unknown name, or the same class name in more than one module. The CLI and
 * the MCP tool both surface `message` verbatim.
 */
export class EntityResolutionError extends Error {
  constructor(
    message: string,
    readonly candidates: string[] = [],
  ) {
    super(message)
    this.name = 'EntityResolutionError'
  }
}

export function routeDefinitionToContextRoute(def: RouteDefinition): ContextRoute {
  return {
    method: def.method.toUpperCase(),
    path: def.path,
    name: def.name,
    controller: def.controller,
    bindings: def.bindings,
    middleware: def.middlewareNames && def.middlewareNames.length > 0 ? def.middlewareNames : undefined,
    params: schemaToTypeString(def.schemas?.params),
    query: schemaToTypeString(def.schemas?.query),
    body: schemaToTypeString(def.schemas?.body),
    output: schemaToTypeString(def.schemas?.output),
  }
}

interface DiscoveredModel {
  info: ModelInfo
  relPath: string
  module: string | null
}

async function discoverParsedModels(cwd: string): Promise<DiscoveredModel[]> {
  const files = await discoverModelFiles(cwd)
  const models: DiscoveredModel[] = []
  for (const file of files) {
    const info = await parseModelFile(file)
    if (!info) continue
    const relPath = toPosixRelative(cwd, file)
    models.push({ info, relPath, module: moduleNameFromRelPath(relPath) })
  }
  return models
}

function resolveEntity(
  entityName: string,
  models: DiscoveredModel[],
  moduleFilter?: string,
): DiscoveredModel {
  const lower = entityName.toLowerCase()
  let matches = models.filter((m) => m.info.className.toLowerCase() === lower)
  if (moduleFilter) {
    matches = matches.filter((m) => m.module === moduleFilter)
  }

  if (matches.length === 0) {
    const available = models.map((m) => m.info.className).sort()
    throw new EntityResolutionError(
      `Model "${entityName}" not found${moduleFilter ? ` in module "${moduleFilter}"` : ''}.`
        + (available.length > 0 ? ` Available models: ${available.join(', ')}` : ' No models discovered.'),
      available,
    )
  }

  if (matches.length > 1) {
    const locations = matches.map((m) => m.module ?? 'app').sort()
    throw new EntityResolutionError(
      `Model "${entityName}" exists in multiple locations: ${locations.join(', ')}. Pass --module <name> to disambiguate.`,
      locations,
    )
  }

  return matches[0]
}

/** Public class method names of the first exported class in a source file. */
function extractClassActions(source: string): string[] {
  let ast: ReturnType<typeof parse>
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  } catch {
    return []
  }

  for (const node of ast.program.body) {
    const classDecl =
      node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration'
        ? node.declaration
        : node.type === 'ExportDefaultDeclaration' && node.declaration?.type === 'ClassDeclaration'
          ? node.declaration
          : node.type === 'ClassDeclaration'
            ? node
            : null
    if (!classDecl) continue

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

  return []
}

/**
 * Page IDs referenced from a controller source via `this.inertia(...)` —
 * both the string-literal form (`this.inertia('posts/Index')`) and the
 * typed-manifest form (`this.inertia(pages.posts.Index)`), the same two
 * shapes `guren check` recognizes.
 */
function extractInertiaPageIds(source: string): string[] {
  const inertiaCallRegex = /this\.inertia\(\s*(?:pages\.([\w.]+)|['"]([^'"]+)['"])/g
  const ids = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = inertiaCallRegex.exec(source)) !== null) {
    const id = match[1] ? match[1].split('.').join('/') : match[2]
    if (id) ids.add(id)
  }
  return [...ids]
}

async function resolvePages(cwd: string, pageIds: string[]): Promise<EntityPage[]> {
  const pages: EntityPage[] = []
  for (const id of pageIds.sort()) {
    let filePath: string | undefined
    for (const ext of ['tsx', 'jsx']) {
      const candidate = `resources/js/pages/${id}.${ext}`
      if (await fileExists(cwd, candidate)) {
        filePath = candidate
        break
      }
    }

    if (!filePath) {
      pages.push({ id, filePath: `resources/js/pages/${id}.tsx` })
      continue
    }

    let props: string | undefined
    try {
      const extracted = await extractPageProps(resolve(cwd, filePath), id)
      // Props types can span lines; collapse whitespace for one-line rendering.
      props = extracted.rawType?.replace(/\s+/g, ' ').trim() ?? undefined
    } catch {
      // Unparsable page — still list it, just without props.
    }

    pages.push({ id, filePath, props })
  }
  return pages
}

async function findSeeders(cwd: string, entityName: string): Promise<string[]> {
  const roots = [cwd, ...(await listModuleNames(cwd)).map((name) => resolve(cwd, 'modules', name))]
  const seederPattern = new RegExp(`(?:^|_)${entityName}s?Seeder\\.`, 'i')

  const seeders: string[] = []
  for (const root of roots) {
    const files = await collectFiles(resolve(root, 'db/seeders'))
    for (const file of files) {
      const base = file.split('/').pop() ?? ''
      if (seederPattern.test(base)) {
        seeders.push(toPosixRelative(cwd, file))
      }
    }
  }
  return seeders.sort()
}

export async function generateEntityContext(
  entityName: string,
  options: EntityContextOptions = {},
): Promise<EntityContext> {
  const cwd = resolve(options.cwd ?? process.cwd())

  const models = await discoverParsedModels(cwd)
  const match = resolveEntity(entityName, models, options.module)
  const entity = match.info.className

  // Schema columns (names only until the Part 3 schema parser lands)
  let columns: string[] | undefined
  if (match.info.tableName) {
    const tables = await parseSchemaTableColumns(cwd)
    columns = tables?.get(match.info.tableName)
  }

  // Reverse relationship edges from every other model
  const referencedBy = models
    .filter((m) => m !== match)
    .flatMap((m) =>
      m.info.relationships
        .filter((rel) => rel.relatedModel === entity)
        .map((rel) => ({ model: m.info.className, relationship: rel.name, type: rel.type })),
    )
    .sort((a, b) => a.model.localeCompare(b.model) || a.relationship.localeCompare(b.relationship))

  // Routes: controller-name convention plus route model bindings
  const controllerName = `${entity}Controller`
  let routes: ContextRoute[] = []
  try {
    const definitions = await loadRouteDefinitions(
      resolve(cwd, options.routesFile ?? DEFAULT_ROUTES_FILE),
      cwd,
    )
    routes = definitions
      .filter(
        (def) =>
          def.controller?.name === controllerName
          || (def.bindings && Object.values(def.bindings).includes(entity)),
      )
      .map(routeDefinitionToContextRoute)
  } catch {
    // Routes may not be loadable (missing deps, etc.) — same tolerance as generateContext.
  }

  // Controller (prefer the one in the entity's own module when duplicated)
  const controllerFiles = (await discoverControllerFiles(cwd)).filter(
    (file) => classNameFromPath(file) === controllerName,
  )
  const controllerFile =
    controllerFiles.find(
      (file) => moduleNameFromRelPath(toPosixRelative(cwd, file)) === match.module,
    ) ?? controllerFiles[0]

  let controller: EntityContext['controller']
  let pages: EntityPage[] = []
  if (controllerFile) {
    const source = await readFile(controllerFile, 'utf-8')
    controller = {
      className: controllerName,
      filePath: toPosixRelative(cwd, controllerFile),
      actions: extractClassActions(source),
    }
    pages = await resolvePages(cwd, extractInertiaPageIds(source))
  }

  const findByClassName = async (
    discover: (root: string) => Promise<string[]>,
    className: string,
  ): Promise<EntityFileRef | undefined> => {
    const file = (await discover(cwd)).find((f) => classNameFromPath(f) === className)
    return file ? { className, filePath: toPosixRelative(cwd, file) } : undefined
  }

  const resource = await findByClassName(discoverResourceFiles, `${entity}Resource`)
  const policy = await findByClassName(discoverPolicyFiles, `${entity}Policy`)
  const seeders = await findSeeders(cwd, entity)

  const tests = (await discoverTestFiles(cwd))
    .filter((file) => (file.split('/').pop() ?? '').includes(entity))
    .map((file) => toPosixRelative(cwd, file))
    .sort()

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
    controller,
    pages,
    resource,
    policy,
    seeders,
    tests,
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
      lines.push(
        `| ${route.method} | ${route.path} | ${route.name ?? ''} | ${action} | ${route.params ?? ''} | ${route.body ?? ''} |`,
      )
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
      const props = page.props ? ` — Props: \`${page.props}\`` : ''
      lines.push(`- ${page.id}${props}`)
    }
    lines.push('')
  }

  const singleRefs: Array<[string, EntityFileRef | undefined]> = [
    ['Resource', ctx.resource],
    ['Policy', ctx.policy],
  ]
  for (const [title, ref] of singleRefs) {
    if (ref) {
      lines.push(`## ${title} — ${ref.filePath}`)
      lines.push('')
    }
  }

  const listSections: Array<[string, string[]]> = [
    ['Seeders', ctx.seeders],
    ['Tests', ctx.tests],
  ]
  for (const [title, items] of listSections) {
    if (items.length > 0) {
      lines.push(`## ${title} (${items.length})`)
      for (const item of items) {
        lines.push(`- ${item}`)
      }
      lines.push('')
    }
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
