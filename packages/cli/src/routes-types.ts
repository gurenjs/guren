import { relative, resolve } from 'node:path'
import { writeGeneratedFile, type WriterOptions } from './utils'
import { loadRouteDefinitions } from './load-routes'
import {
  DECLARATION_MODULE_AUGMENTATION,
  RUNTIME_TYPE_DEFINITIONS,
  RUNTIME_ROUTE_FUNCTION,
  RUNTIME_UTILITY_FUNCTIONS,
} from './routes-types-fragments'

export type RouteDefinition = {
  method: string
  path: string
  name?: string
}

export interface GenerateRouteTypesOptions extends WriterOptions {
  routesFile?: string
  outputFile?: string
  runtimeOutputFile?: string
  appRoot?: string
}

const DEFAULT_ROUTES_FILE = 'routes/web.ts'
const DEFAULT_OUTPUT_FILE = 'types/generated/routes.d.ts'
const DEFAULT_RUNTIME_OUTPUT_FILE = '.guren/routes.gen.ts'

export async function generateRouteTypes(
  options: GenerateRouteTypesOptions = {},
): Promise<{ outputPath: string; runtimeOutputPath: string; definitions: RouteDefinition[] }> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const routesFile = resolve(appRoot, options.routesFile ?? DEFAULT_ROUTES_FILE)
  const outputFile = resolve(appRoot, options.outputFile ?? DEFAULT_OUTPUT_FILE)
  const runtimeOutputFile = resolve(appRoot, options.runtimeOutputFile ?? DEFAULT_RUNTIME_OUTPUT_FILE)
  const definitions = await loadRouteDefinitions(routesFile, appRoot)

  if (definitions.length === 0) {
    throw new Error('No routes were registered. Ensure your routes file exports a route registrar and registers routes with the provided router.')
  }

  const declaration = buildDeclarationContent(definitions, {
    source: relative(appRoot, routesFile) || DEFAULT_ROUTES_FILE,
  })
  const runtimeModule = buildRouteModuleContent(definitions, {
    source: relative(appRoot, routesFile) || DEFAULT_ROUTES_FILE,
  })

  const relativeTarget = relative(process.cwd(), outputFile) || outputFile
  const relativeRuntimeTarget = relative(process.cwd(), runtimeOutputFile) || runtimeOutputFile
  const outputPath = await writeGeneratedFile(relativeTarget, declaration, { force: options.force })
  const runtimeOutputPath = await writeGeneratedFile(relativeRuntimeTarget, runtimeModule, { force: options.force })

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

  const tsNoCheck = namedDefinitions.length === 0 ? '// @ts-nocheck\n' : ''

  return `\
${tsNoCheck}// Generated from ${context.source} — DO NOT EDIT
// Run \`guren codegen\` to regenerate.

export const routeManifest = {
${manifestEntries}
} as const

${RUNTIME_TYPE_DEFINITIONS}
${RUNTIME_ROUTE_FUNCTION}
export const routes = ${helperObject} as const

${RUNTIME_UTILITY_FUNCTIONS}`
}

export function toTypeLiteral(path: string): string {
  if (!path.includes(':')) {
    return `'${escapeSingleQuotes(path)}'`
  }

  const segments = path.split('/')
  const rendered = segments
    .map((segment) => {
      if (!segment) {
        return ''
      }

      if (segment.startsWith(':')) {
        return '${string}'
      }

      return escapeTemplateSegment(segment)
    })
    .join('/')

  const normalized = rendered.startsWith('/') ? rendered : `/${rendered}`

  return `\`${normalized}\``
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")
}

function escapeTemplateSegment(value: string): string {
  return value.replace(/`/gu, '\\`').replace(/\\/gu, '\\\\')
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

const VALID_JS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u

function quoteKey(segment: string): string {
  return VALID_JS_IDENTIFIER.test(segment) ? segment : `'${escapeSingleQuotes(segment)}'`
}

function renderHelperNode(segment: string, node: HelperTreeNode, depth: number): string {
  const key = quoteKey(segment)

  if (node.route && node.children.size === 0) {
    const params = extractParamNames(node.route.path)
    if (params.length === 0) {
      return `${key}: (query?: RouteQuery) => route('${node.route.name}', query)`
    }

    return `${key}: (params: RouteParams<'${node.route.name}'>, query?: RouteQuery) => route('${node.route.name}', params, query)`
  }

  if (node.route && node.children.size > 0) {
    const params = extractParamNames(node.route.path)
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

function extractParamNames(path: string): string[] {
  return Array.from(path.matchAll(/:([A-Za-z0-9_-]+)/gu), (match) => match[1])
}
