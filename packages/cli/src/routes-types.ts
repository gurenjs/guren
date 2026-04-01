import { relative, resolve } from 'node:path'
import { writeFileSafe, type WriterOptions } from './utils'
import { loadRouteDefinitions } from './load-routes'
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
  const definitions = await loadRouteDefinitions(routesFile)

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
  const outputPath = await writeFileSafe(relativeTarget, declaration, { force: options.force })
  const runtimeOutputPath = await writeFileSafe(relativeRuntimeTarget, runtimeModule, { force: options.force })

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

  const header = `// Generated from ${context.source} — DO NOT EDIT\n// Run \`guren codegen\` to regenerate.\n\nimport type { RequestPayload, VisitOptions } from '@inertiajs/core'\n\nexport {}\n\n`

  const methodUnion = methods.length > 0 ? methods.map((method) => `'${method}'`).join(' | ') : 'never'

  return `${header}declare namespace Guren {\n  export type RouteMethod = ${methodUnion}\n\n  export type RoutePath =\n${routeLines}\n\n  export type RouteUrl = RoutePath | \`${'${'}RoutePath${'}'}?${'${'}string${'}'}\`\n\n  export interface RouteMeta {\n    method: RouteMethod\n    path: RoutePath\n    name?: string\n  }\n}\n\ndeclare module '@inertiajs/react' {\n  interface BaseInertiaLinkProps {\n    href: Guren.RouteUrl\n  }\n}\n\ndeclare module '@inertiajs/core' {\n  interface Router {\n    visit(href: Guren.RouteUrl, options?: VisitOptions): void\n    get(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void\n    post(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void\n    put(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void\n    patch(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void\n    delete(url: Guren.RouteUrl, options?: Omit<VisitOptions, 'method'>): void\n    replace(url: Guren.RouteUrl, options?: Omit<VisitOptions, 'replace'>): void\n  }\n}\n`
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

  const header = `// Generated from ${context.source} — DO NOT EDIT\n// Run \`guren codegen\` to regenerate.\n\n`

  return `${header}export const routeManifest = {\n${manifestEntries}\n} as const\n\nexport type RouteManifest = typeof routeManifest\nexport type RouteName = keyof RouteManifest\nexport type RouteMethod = [RouteName] extends [never] ? string : RouteManifest[RouteName]['method']\nexport type RoutePath = [RouteName] extends [never] ? string : RouteManifest[RouteName]['path']\n\ntype PrimitiveQueryValue = string | number | boolean | null | undefined\ntype QueryValue = PrimitiveQueryValue | readonly PrimitiveQueryValue[]\nexport type RouteQuery = Record<string, QueryValue>\n\ntype NormalizeParamKey<TValue extends string> = TValue extends \`${'${'}infer Key${'}'}?\` ? Key : TValue\ntype PathParamKeys<TPath extends string> =\n  TPath extends \`${'${'}string${'}'}:${'${'}infer Param${'}'}/${'${'}infer Rest${'}'}\`\n    ? NormalizeParamKey<Param> | PathParamKeys<\`/${'${'}Rest${'}'}\`>\n    : TPath extends \`${'${'}string${'}'}:${'${'}infer Param${'}'}\`\n      ? NormalizeParamKey<Param>\n      : never\n\nexport type RouteParams<TName extends RouteName> =\n  [PathParamKeys<RouteManifest[TName]['path']>] extends [never]\n    ? Record<string, never>\n    : { [TKey in PathParamKeys<RouteManifest[TName]['path']>]: string | number }\n\ntype RouteArgs<TName extends RouteName> =\n  [PathParamKeys<RouteManifest[TName]['path']>] extends [never]\n    ? [query?: RouteQuery]\n    : [params: RouteParams<TName>, query?: RouteQuery]\n\nexport function route<TName extends RouteName>(name: TName, ...args: RouteArgs<TName>): string {\n  const definition = routeManifest[name]\n  if (!definition) {\n    throw new Error(\`Route [\${String(name)}] not defined.\`)\n  }\n\n  const [firstArg, secondArg] = args as [RouteQuery | RouteParams<TName> | undefined, RouteQuery | undefined]\n  const params = (args.length > 1 ? firstArg : hasPathParams(definition.path) ? firstArg : undefined) as RouteParams<TName> | undefined\n  const query = (args.length > 1 ? secondArg : hasPathParams(definition.path) ? undefined : firstArg) as RouteQuery | undefined\n  const path = substituteParams(definition.path, params as Record<string, string | number> | undefined)\n  return appendQueryString(path, query)\n}\n\nexport const routes = ${helperObject} as const\n\nfunction hasPathParams(path: string): boolean {\n  return /:[A-Za-z0-9_-]+/u.test(path)\n}\n\nfunction substituteParams(path: string, params?: Record<string, string | number>): string {\n  if (!params) {\n    return path\n  }\n\n  return path.replace(/:([A-Za-z0-9_-]+)/gu, (match, key) => {\n    if (!Object.prototype.hasOwnProperty.call(params, key)) {\n      return match\n    }\n\n    return encodeURIComponent(String(params[key]))\n  })\n}\n\nfunction appendQueryString(path: string, query?: RouteQuery): string {\n  if (!query) {\n    return path\n  }\n\n  const search = new URLSearchParams()\n\n  for (const [key, value] of Object.entries(query)) {\n    if (value == null) {\n      continue\n    }\n\n    if (Array.isArray(value)) {\n      for (const item of value) {\n        if (item != null) {\n          search.append(key, String(item))\n        }\n      }\n      continue\n    }\n\n    search.set(key, String(value))\n  }\n\n  const serialized = search.toString()\n  return serialized ? \`${'${'}path${'}'}?\${serialized}\` : path\n}\n`
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
