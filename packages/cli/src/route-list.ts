import { resolve } from 'node:path'
import { consola } from 'consola'
import { loadRouteDefinitions, DEFAULT_ROUTES_FILE } from './load-routes'

export interface RouteListOptions {
  /**
   * Routes entry file path.
   */
  routesFile?: string

  /**
   * Application root directory.
   */
  appRoot?: string

  /**
   * Filter by HTTP method.
   */
  method?: string

  /**
   * Filter by path pattern.
   */
  path?: string

  /**
   * Filter by route name.
   */
  name?: string

  /**
   * Output format: table, json, or compact.
   */
  format?: 'table' | 'json' | 'compact'

  /**
   * Sort by: method, path, name.
   */
  sort?: 'method' | 'path' | 'name'

  /**
   * Reverse sort order.
   */
  reverse?: boolean
}

export interface RouteInfo {
  method: string
  path: string
  name?: string
}

/**
 * List all registered routes.
 */
export async function listRoutes(options: RouteListOptions = {}): Promise<RouteInfo[]> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const routesFile = resolve(appRoot, options.routesFile ?? DEFAULT_ROUTES_FILE)

  let definitions
  try {
    definitions = await loadRouteDefinitions(routesFile, appRoot)
  } catch (error) {
    throw new Error(
      `Failed to import routes file (${routesFile}): ${error instanceof Error ? error.message : String(error)}`
    )
  }

  let routes = definitions.map((def) => ({
    method: def.method.toUpperCase(),
    path: def.path,
    name: def.name,
  }))

  // Apply filters
  if (options.method) {
    const method = options.method.toUpperCase()
    routes = routes.filter((r) => r.method === method)
  }

  if (options.path) {
    const pattern = options.path.toLowerCase()
    routes = routes.filter((r) => r.path.toLowerCase().includes(pattern))
  }

  if (options.name) {
    const namePattern = options.name.toLowerCase()
    routes = routes.filter((r) => r.name?.toLowerCase().includes(namePattern))
  }

  // Apply sorting
  if (options.sort) {
    routes.sort((a, b) => {
      const aValue = a[options.sort!] ?? ''
      const bValue = b[options.sort!] ?? ''
      return String(aValue).localeCompare(String(bValue))
    })
  }

  if (options.reverse) {
    routes.reverse()
  }

  return routes
}

/**
 * Display routes in the terminal.
 */
export async function displayRoutes(options: RouteListOptions = {}): Promise<void> {
  const routes = await listRoutes(options)

  if (routes.length === 0) {
    consola.warn('No routes found.')
    return
  }

  const format = options.format ?? 'table'

  if (format === 'json') {
    console.log(JSON.stringify(routes, null, 2))
    return
  }

  if (format === 'compact') {
    for (const route of routes) {
      const name = route.name ? ` [${route.name}]` : ''
      console.log(`${padMethod(route.method)} ${route.path}${name}`)
    }
    return
  }

  // Table format
  printRouteTable(routes)
}

function padMethod(method: string): string {
  const colors: Record<string, string> = {
    GET: '\x1b[32m',     // green
    POST: '\x1b[33m',    // yellow
    PUT: '\x1b[34m',     // blue
    PATCH: '\x1b[36m',   // cyan
    DELETE: '\x1b[31m',  // red
    QUERY: '\x1b[32m',   // green — safe like GET
    HEAD: '\x1b[35m',    // magenta
    OPTIONS: '\x1b[90m', // gray
  }
  const reset = '\x1b[0m'
  const color = colors[method] ?? ''
  return `${color}${method.padEnd(7)}${reset}`
}

function printRouteTable(routes: RouteInfo[]): void {
  // Calculate column widths
  const methodWidth = 7
  const pathWidth = Math.max(4, ...routes.map((r) => r.path.length))
  const nameWidth = Math.max(4, ...routes.map((r) => (r.name ?? '').length))

  const hasNames = routes.some((r) => r.name)

  // Print header
  let header = `${'Method'.padEnd(methodWidth)} | ${'Path'.padEnd(pathWidth)}`
  if (hasNames) {
    header += ` | ${'Name'.padEnd(nameWidth)}`
  }

  console.log('\x1b[1m' + header + '\x1b[0m')
  console.log('-'.repeat(header.length))

  // Print routes
  for (const route of routes) {
    let line = `${padMethod(route.method)} | ${route.path.padEnd(pathWidth)}`

    if (hasNames) {
      line += ` | ${(route.name ?? '').padEnd(nameWidth)}`
    }

    console.log(line)
  }

  // Print summary
  console.log('')
  console.log(`Total: ${routes.length} route${routes.length === 1 ? '' : 's'}`)
}
