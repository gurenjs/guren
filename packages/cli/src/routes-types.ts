import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Route } from '@guren/server'
import { writeFileSafe, type WriterOptions } from './utils'
type RouteDefinition = {
  method: string
  path: string
  name?: string
}

export interface GenerateRouteTypesOptions extends WriterOptions {
  routesFile?: string
  outputFile?: string
  appRoot?: string
}

const DEFAULT_ROUTES_FILE = 'routes/web.ts'
const DEFAULT_OUTPUT_FILE = 'types/generated/routes.d.ts'

export async function generateRouteTypes(options: GenerateRouteTypesOptions = {}): Promise<{ outputPath: string; definitions: RouteDefinition[] }> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const routesFile = resolve(appRoot, options.routesFile ?? DEFAULT_ROUTES_FILE)
  const outputFile = resolve(appRoot, options.outputFile ?? DEFAULT_OUTPUT_FILE)

  Route.clear()

  await import(pathToFileURL(routesFile).href)

  const definitions = Route.definitions()

  if (definitions.length === 0) {
    throw new Error('No routes were registered. Ensure your routes file registers routes via Route.*.')
  }

  const declaration = buildDeclarationContent(definitions, {
    source: relative(appRoot, routesFile) || DEFAULT_ROUTES_FILE,
  })

  const relativeTarget = relative(process.cwd(), outputFile) || outputFile
  const outputPath = await writeFileSafe(relativeTarget, declaration, { force: options.force })

  return {
    outputPath,
    definitions,
  }
}

function buildDeclarationContent(definitions: RouteDefinition[], context: { source: string }): string {
  const uniquePaths = Array.from(new Set(definitions.map((route) => route.path))).sort()
  const templateLiterals = uniquePaths.map((path) => toTypeLiteral(path))

  const methods = Array.from(new Set(definitions.map((route) => route.method))).sort()

  const routeLines = templateLiterals.length > 0
    ? templateLiterals.map((literal, index) => `    ${index === 0 ? '' : '| '}${literal}`).join('\n')
    : '    never'

  const header = `// Generated from ${context.source} — DO NOT EDIT\n// Run \`guren routes:types\` to regenerate.\n\nimport type { RequestPayload, VisitOptions } from '@inertiajs/core'\n\nexport {}\n\n`

  const methodUnion = methods.length > 0 ? methods.map((method) => `'${method}'`).join(' | ') : 'never'

  return `${header}declare namespace Guren {\n  export type RouteMethod = ${methodUnion}\n\n  export type RoutePath =\n${routeLines}\n\n  export type RouteUrl = RoutePath | \`${'${'}RoutePath${'}'}?${'${'}string${'}'}\`\n\n  export interface RouteMeta {\n    method: RouteMethod\n    path: RoutePath\n    name?: string\n  }\n}\n\ndeclare module '@inertiajs/react' {\n  interface BaseInertiaLinkProps {\n    href: Guren.RouteUrl\n  }\n}\n\ndeclare module '@inertiajs/core' {\n  interface Router {\n    visit(href: Guren.RouteUrl, options?: VisitOptions): void\n    get(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void\n    post(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void\n    put(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void\n    patch(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void\n    delete(url: Guren.RouteUrl, options?: Omit<VisitOptions, 'method'>): void\n    replace(url: Guren.RouteUrl, options?: Omit<VisitOptions, 'replace'>): void\n  }\n}\n`
}

function toTypeLiteral(path: string): string {
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
