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
  discoverCommandFiles,
  classNameFromPath,
  readIfExists,
  excludeBarrelFiles,
} from './discovery'
import { GUREN_API_DIGEST } from './api-digest'
import { parseModelFile, type ModelInfo } from './model-parser'
import { loadContextRoutes, escapeMarkdownTableCell, type ContextRoute } from './context-route'
import { listInertiaPageIds } from './inertia-pages'

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
  commands: string[]
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

  const collectModels = async (): Promise<ModelInfo[]> => {
    const modelFiles = await discoverModelFiles(cwd)
    const parsed = await Promise.all(modelFiles.map((file) => parseModelFile(file)))
    const models = parsed.flatMap((info, index) => {
      if (!info) return []
      info.filePath = relative(cwd, modelFiles[index])
      return [info]
    })
    return models.sort((a, b) => a.className.localeCompare(b.className))
  }

  const toNames = async (discover: (root: string) => Promise<string[]>) => {
    const files = excludeBarrelFiles(await discover(cwd))
    return files.map(classNameFromPath).sort()
  }

  // Every source below is independent — one barrier instead of a dozen
  // serialized directory walks (plus the route-graph import).
  const [
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
    commands,
  ] = await Promise.all([
    collectModels(),
    loadContextRoutes(cwd, options.routesFile),
    listInertiaPageIds(cwd),
    toNames(discoverControllerFiles),
    toNames(discoverResourceFiles),
    toNames(discoverEventFiles),
    toNames(discoverJobFiles),
    toNames(discoverMiddlewareFiles),
    toNames(discoverListenerFiles),
    toNames(discoverValidatorFiles),
    toNames(discoverPolicyFiles),
    toNames(discoverCommandFiles),
  ])

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
    commands,
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
      const cells = [route.method, route.path, route.name ?? '', controller]
      lines.push(`| ${cells.map(escapeMarkdownTableCell).join(' | ')} |`)
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
    ['Console Commands', ctx.commands],
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

  // The digest rides along on every markdown rendering (session-start hook,
  // MCP guren_get_context, ad-hoc CLI runs) so agents see the signatures
  // before their first edit attaches the glob-scoped rule files.
  lines.push(GUREN_API_DIGEST)
  lines.push('')

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
