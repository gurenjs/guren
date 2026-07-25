import { resolve, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { consola } from 'consola'
import {
  discoverModelFiles,
  discoverControllerFiles,
  discoverResourceFiles,
  discoverEventFiles,
  discoverJobFiles,
  discoverMiddlewareFiles,
  discoverListenerFiles,
  discoverValidatorFiles,
  discoverPolicyFiles,
  classNameFromPath,
  readIfExists,
  collectFiles,
  excludeBarrelFiles,
} from './discovery'
import { parseModelFile, type ModelInfo } from './model-parser'
import { loadRouteDefinitions } from './load-routes'
import { routeDefinitionToContextRoute, type ContextRoute } from './entity-context'

export interface ProjectContext {
  framework: { name: string; version: string }
  models: ModelInfo[]
  routes: ContextRoute[]
  pages: string[]
  controllers: string[]
  resources: string[]
  events: string[]
  jobs: string[]
  middleware: string[]
  listeners: string[]
  validators: string[]
  policies: string[]
}

export interface ContextOptions {
  cwd?: string
  json?: boolean
  routesFile?: string
}

export async function generateContext(options: ContextOptions = {}): Promise<ProjectContext> {
  const cwd = resolve(options.cwd ?? process.cwd())

  // Framework version
  let version = 'unknown'
  const pkgRaw = await readIfExists(cwd, 'package.json')
  if (pkgRaw) {
    const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    version = pkg.dependencies?.['@guren/core'] ?? pkg.devDependencies?.['@guren/core'] ?? 'unknown'
  }

  // Models
  const modelFiles = await discoverModelFiles(cwd)
  const models: ModelInfo[] = []
  for (const f of modelFiles) {
    const info = await parseModelFile(f)
    if (info) {
      info.filePath = relative(cwd, info.filePath)
      models.push(info)
    }
  }
  models.sort((a, b) => a.className.localeCompare(b.className))

  // Routes — full RouteDefinition payload (controller binding, schemas as
  // rendered type strings), not the lossy method/path/name view.
  let routes: ContextRoute[] = []
  try {
    const definitions = await loadRouteDefinitions(
      resolve(cwd, options.routesFile ?? 'routes/web.ts'),
      cwd,
    )
    routes = definitions.map(routeDefinitionToContextRoute)
  } catch {
    // Routes may not be loadable (missing deps, etc.)
  }

  // Pages
  const pagesDir = resolve(cwd, 'resources/js/pages')
  const pageExts = new Set(['.tsx', '.jsx', '.ts', '.js'])
  const pageFiles = await collectFiles(pagesDir, pageExts)
  const pages = pageFiles
    .map((f) => relative(pagesDir, f).replace(/\.(tsx|jsx|ts|js)$/, ''))
    .filter((p) => !p.startsWith('contracts'))
    .sort()

  // Other components
  const toNames = async (discover: (root: string) => Promise<string[]>) => {
    const files = excludeBarrelFiles(await discover(cwd))
    return files.map(classNameFromPath).sort()
  }

  const controllers = await toNames(discoverControllerFiles)
  const resources = await toNames(discoverResourceFiles)
  const events = await toNames(discoverEventFiles)
  const jobs = await toNames(discoverJobFiles)
  const middleware = await toNames(discoverMiddlewareFiles)
  const listeners = await toNames(discoverListenerFiles)
  const validators = await toNames(discoverValidatorFiles)
  const policies = await toNames(discoverPolicyFiles)

  return {
    framework: { name: 'Guren', version },
    models,
    routes,
    pages,
    controllers,
    resources,
    events,
    jobs,
    middleware,
    listeners,
    validators,
    policies,
  }
}

export function renderContextMarkdown(ctx: ProjectContext): string {
  const lines: string[] = []

  lines.push(`# Project Context`)
  lines.push('')
  lines.push(`## Stack`)
  lines.push(`- Framework: ${ctx.framework.name} ${ctx.framework.version}`)
  lines.push(`- Runtime: Bun`)
  lines.push(`- ORM: Drizzle`)
  lines.push(`- Frontend: React + Inertia.js`)
  lines.push('')

  // Models
  lines.push(`## Models (${ctx.models.length})`)
  if (ctx.models.length === 0) {
    lines.push('No models found.')
  }
  for (const model of ctx.models) {
    const traits: string[] = []
    if (model.usesAuth) traits.push('Authenticatable')
    if (model.hasSoftDeletes) traits.push('SoftDeletes')
    const traitStr = traits.length > 0 ? ` [${traits.join(', ')}]` : ''
    lines.push(`### ${model.className}${traitStr}`)
    if (model.tableName) lines.push(`- Table: \`${model.tableName}\``)
    if (model.relationships.length > 0) {
      for (const rel of model.relationships) {
        const target = rel.relatedModel ? ` → ${rel.relatedModel}` : ''
        lines.push(`- ${rel.type}: \`${rel.name}\`${target}`)
      }
    }
    lines.push('')
  }

  // Routes
  lines.push(`## Routes (${ctx.routes.length})`)
  if (ctx.routes.length > 0) {
    lines.push('| Method | Path | Name | Controller |')
    lines.push('|--------|------|------|------------|')
    for (const route of ctx.routes) {
      const controller = route.controller
        ? `${route.controller.name}.${route.controller.action}`
        : ''
      lines.push(`| ${route.method} | ${route.path} | ${route.name ?? ''} | ${controller} |`)
    }
  } else {
    lines.push('No routes loaded.')
  }
  lines.push('')

  // Pages
  lines.push(`## Pages (${ctx.pages.length})`)
  for (const page of ctx.pages) {
    lines.push(`- ${page}`)
  }
  lines.push('')

  // Component lists
  const sections: [string, string[]][] = [
    ['Controllers', ctx.controllers],
    ['Resources', ctx.resources],
    ['Events', ctx.events],
    ['Jobs', ctx.jobs],
    ['Middleware', ctx.middleware],
    ['Listeners', ctx.listeners],
    ['Validators', ctx.validators],
    ['Policies', ctx.policies],
  ]

  for (const [title, items] of sections) {
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

export async function displayContext(options: ContextOptions = {}): Promise<void> {
  const ctx = await generateContext(options)

  if (options.json) {
    console.log(JSON.stringify(ctx, null, 2))
    return
  }

  const md = renderContextMarkdown(ctx)
  console.log(md)
}
