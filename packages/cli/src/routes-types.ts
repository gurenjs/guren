import { relative, resolve } from 'node:path'
import { consola } from 'consola'
import type { DerivedAgentTool, RouteDefinition as ServerRouteDefinition } from '@guren/server'
import { loadIntrospectedRouteDefinitions } from './app-routes'
import { introspectApp } from './introspect'
import { introspectionUnavailableMessage, ROUTES_FLAG_NOT_INTROSPECTED } from './manifest-section'
import { routesEntryOrDefault } from './route-registrar'
import { PATH_PARAM_PATTERN, escapeSingleQuoted as escapeSingleQuotes, escapeTemplateLiteral as escapeTemplateSegment, extractPathParamNames, quoteObjectKey, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'
import { CONTRACT_SEGMENTS } from './contract-segments'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitions } from './load-routes'
import {
  DECLARATION_MODULE_AUGMENTATION,
  RUNTIME_TYPE_DEFINITIONS,
  RUNTIME_ROUTE_FUNCTION,
  RUNTIME_UTILITY_FUNCTIONS,
} from './routes-types-fragments'
import { schemaToTypeString } from './schema-type-extractor'

export type RouteDefinition = {
  method: string
  path: string
  name?: string
  schemas?: ServerRouteDefinition['schemas']
  /**
   * The introspected app's derived tool for an agent route the routes file does not register,
   * which reaches codegen without Zod (and without `agent`, so nothing derives it twice).
   */
  introspectedAgentTool?: DerivedAgentTool
}

export interface GenerateRouteTypesOptions extends WriterOptions {
  routesFile?: string
  outputFile?: string
  runtimeOutputFile?: string
  appRoot?: string
  /**
   * Take the route set from the introspected app (RFC 0026 §5), each route keeping the routes
   * file's Zod where it registers one: `guren codegen --introspect`. Off by default: the Vite
   * watcher runs codegen on every edit, and a generated file must not depend on the path that wrote it.
   */
  introspect?: boolean
}

/**
 * The routes codegen renders. Introspected, a route the routes file does not register (a
 * provider's) is rendered without schema types, and an agent tool on it is the manifest's.
 * A failed or unusable introspection falls back to the routes file, saying why.
 */
async function loadCodegenRoutes(routesFile: string, appRoot: string, introspect: boolean): Promise<RouteDefinition[]> {
  const loadStatic = () => loadRouteDefinitions(routesFile, appRoot)
  if (!introspect) return loadStatic()

  // The manifest describes the entry's routes, which a file `--routes` names may not be.
  const entryRoutes = resolve(appRoot, await routesEntryOrDefault(appRoot))
  const introspection = entryRoutes === routesFile ? () => introspectApp(appRoot) : { skipped: ROUTES_FLAG_NOT_INTROSPECTED }
  const { definitions, source } = await loadIntrospectedRouteDefinitions(introspection, loadStatic)
  if (source.evidence === 'static') {
    consola.warn(source.failure
      ? introspectionUnavailableMessage(source.failure, 'Generated from the routes file instead.')
      : `Generated from the routes file instead of the introspected app: ${source.reason ?? 'the introspection was not usable'}.`)
    return definitions
  }
  if (source.unmatched.length === 0) return definitions

  consola.warn(
    `${source.unmatched.length} route(s) are registered outside the routes file, so their schemas are not rendered: `
    + `${source.unmatched.map((route) => `${route.method} ${route.path}`).join(', ')}.`,
  )
  const unmatched = new Set(source.unmatched)
  const toolKey = (method: string, path: string, name: string | undefined) => `${method.toUpperCase()} ${path} ${name ?? ''}`
  const tools = new Map(source.manifest.agentTools.map((tool) => [toolKey(tool.method, tool.path, tool.routeName), tool]))
  return definitions.map((definition, index) => {
    if (!unmatched.has(source.manifest.routes[index]!)) return definition
    const { agent, ...rest } = definition
    const tool = agent ? tools.get(toolKey(definition.method, definition.path, definition.name)) : undefined
    return tool ? { ...rest, introspectedAgentTool: tool } : rest
  })
}

const DEFAULT_OUTPUT_FILE = 'types/generated/routes.d.ts'
const DEFAULT_RUNTIME_OUTPUT_FILE = '.guren/routes.gen.ts'

export async function generateRouteTypes(
  options: GenerateRouteTypesOptions = {},
): Promise<{ outputPath: string; runtimeOutputPath: string; definitions: RouteDefinition[] }> {
  const appRoot = resolveAppRoot(options)
  const routesFile = resolve(appRoot, options.routesFile ?? DEFAULT_ROUTES_FILE)
  const outputFile = resolve(appRoot, options.outputFile ?? DEFAULT_OUTPUT_FILE)
  const runtimeOutputFile = resolve(appRoot, options.runtimeOutputFile ?? DEFAULT_RUNTIME_OUTPUT_FILE)
  const definitions = await loadCodegenRoutes(routesFile, appRoot, options.introspect === true)

  if (definitions.length === 0) {
    throw new Error('No routes were registered. Ensure your routes file exports a route registrar and registers routes with the provided router.')
  }

  const declaration = buildDeclarationContent(definitions, {
    source: relative(appRoot, routesFile) || DEFAULT_ROUTES_FILE,
  })
  const runtimeModule = buildRouteModuleContent(definitions, {
    source: relative(appRoot, routesFile) || DEFAULT_ROUTES_FILE,
  })

  const outputPath = await writeGeneratedFileIn(appRoot, outputFile, declaration, { force: options.force })
  const runtimeOutputPath = await writeGeneratedFileIn(appRoot, runtimeOutputFile, runtimeModule, { force: options.force })

  return {
    outputPath,
    runtimeOutputPath,
    definitions,
  }
}

export function buildDeclarationContent(definitions: RouteDefinition[], context: { source: string }): string {
  const uniquePaths = Array.from(new Set(definitions.map((route) => route.path))).sort()
  const templateLiterals = uniquePaths.map((path) => toTypeLiteral(path))

  const methods = Array.from(new Set(definitions.map((route) => route.method))).sort()

  const routeLines = templateLiterals.length > 0
    ? templateLiterals.map((literal, index) => `    ${index === 0 ? '' : '| '}${literal}`).join('\n')
    : '    never'

  const methodUnion = methods.length > 0 ? methods.map((method) => `'${method}'`).join(' | ') : 'never'

  return `\
// Generated from ${context.source} — DO NOT EDIT
// Run \`guren codegen\` to regenerate.

import type { RequestPayload, VisitOptions } from '@inertiajs/core'

export {}

declare namespace Guren {
  export type RouteMethod = ${methodUnion}

  export type RoutePath =
${routeLines}

  export type RouteUrl = RoutePath | \`\${RoutePath}?\${string}\`

  export interface RouteMeta {
    method: RouteMethod
    path: RoutePath
    name?: string
  }
}

${DECLARATION_MODULE_AUGMENTATION}`
}

export function buildRouteModuleContent(definitions: RouteDefinition[], context: { source: string }): string {
  const namedDefinitions = definitions
    .filter((definition): definition is RouteDefinition & { name: string } => Boolean(definition.name))
    .sort((left, right) => left.name.localeCompare(right.name))

  const manifestEntries = namedDefinitions
    .map((definition) => {
      return `  '${definition.name}': { method: '${definition.method}', path: '${escapeSingleQuotes(definition.path)}' },`
    })
    .join('\n')

  const helperTree = buildHelperTree(namedDefinitions)
  const helperObject = renderHelperTree(helperTree, 1)

  return `\
// Generated from ${context.source} — DO NOT EDIT
// Run \`guren codegen\` to regenerate.

export const routeManifest = {
${manifestEntries}
} as const

${RUNTIME_TYPE_DEFINITIONS}
${RUNTIME_ROUTE_FUNCTION}
export const routes = ${helperObject} as const

${RUNTIME_UTILITY_FUNCTIONS}${buildContractAugmentation(namedDefinitions)}`
}

/**
 * The `GurenRouteContracts` registry `Controller.validated()` reads: each named
 * route's segments as its schemas *parse* them (`io: 'output'`, so a coerced
 * number is `number`), unlike `ApiRoutes.body`, which is what a client sends.
 */
function buildContractAugmentation(definitions: Array<RouteDefinition & { name: string }>): string {
  const entries = definitions.flatMap((definition) => {
    const segments = CONTRACT_SEGMENTS.flatMap((segment) => {
      const schema = definition.schemas?.[segment]
      if (!schema) return []
      // A schema that does not render still validates at runtime, so its segment is not `undefined`.
      return [`${segment}: ${schemaToTypeString(schema, { io: 'output' }) ?? 'unknown'}`]
    })
    return segments.length > 0
      ? [`      ${quoteObjectKey(definition.name)}: { ${segments.join('; ')} }`]
      : []
  })
  if (entries.length === 0) return ''

  return `
declare module '@guren/core' {
  interface GurenRouteContracts {
    routes: {
${entries.join('\n')}
    }
  }
}
`
}

export function toTypeLiteral(path: string): string {
  // Masking param tokens first keeps constraint contents (which may include `/`) out of
  // the segment split, and leaves literal segments like `foo:bar` untouched.
  const masked = path.replace(PATH_PARAM_PATTERN, '$1\u0000')

  if (!masked.includes('\u0000')) {
    return `'${escapeSingleQuotes(path)}'`
  }

  const segments = masked.split('/')
  const rendered = segments
    .map((segment) => {
      if (!segment) {
        return ''
      }

      if (segment.includes('\u0000')) {
        return '${string}'
      }

      return escapeTemplateSegment(segment)
    })
    .join('/')

  const normalized = rendered.startsWith('/') ? rendered : `/${rendered}`

  return `\`${normalized}\``
}

type HelperTreeNode = {
  children: Map<string, HelperTreeNode>
  route?: RouteDefinition & { name: string }
}

function createHelperTreeNode(): HelperTreeNode {
  return {
    children: new Map<string, HelperTreeNode>(),
  }
}

function buildHelperTree(definitions: Array<RouteDefinition & { name: string }>): HelperTreeNode {
  const root = createHelperTreeNode()

  for (const definition of definitions) {
    const segments = definition.name.split('.')
    let current = root

    for (const segment of segments) {
      const next = current.children.get(segment) ?? createHelperTreeNode()
      current.children.set(segment, next)
      current = next
    }

    current.route = definition
  }

  return root
}

function renderHelperTree(node: HelperTreeNode, depth: number): string {
  const indentation = '  '.repeat(depth)
  const entries = Array.from(node.children.entries()).map(([segment, child]) => {
    const renderedChild = renderHelperNode(segment, child, depth + 1)
    return `${indentation}${renderedChild}`
  })

  return `{\n${entries.join(',\n')}\n${'  '.repeat(depth - 1)}}`
}

function renderHelperNode(segment: string, node: HelperTreeNode, depth: number): string {
  const key = quoteObjectKey(segment)

  if (node.route && node.children.size === 0) {
    const params = extractPathParamNames(node.route.path)
    if (params.length === 0) {
      return `${key}: (query?: RouteQuery) => route('${node.route.name}', query)`
    }

    return `${key}: (params: RouteParams<'${node.route.name}'>, query?: RouteQuery) => route('${node.route.name}', params, query)`
  }

  if (node.route && node.children.size > 0) {
    const params = extractPathParamNames(node.route.path)
    const selfFn = params.length === 0
      ? `(query?: RouteQuery) => route('${node.route.name}', query)`
      : `(params: RouteParams<'${node.route.name}'>, query?: RouteQuery) => route('${node.route.name}', params, query)`

    const indentation = '  '.repeat(depth)
    const childEntries = Array.from(node.children.entries()).map(([childSegment, child]) => {
      const renderedChild = renderHelperNode(childSegment, child, depth + 1)
      return `${indentation}${renderedChild}`
    })

    return `${key}: Object.assign(\n${indentation}${selfFn},\n${indentation}${`{\n${childEntries.join(',\n')}\n${'  '.repeat(depth - 1)}}`}\n${'  '.repeat(depth - 1)})`
  }

  return `${key}: ${renderHelperTree(node, depth)}`
}
