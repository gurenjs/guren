import { defineCommand } from '../define-command'
import { markCommandFailed } from '../command-status'
import { loadDependencyTree, type LoadedDependencyTree } from '../dependency-tree-load'
import type { DependencyInstance } from '../dependency-tree'
import type { ExposedPackage } from '../dependency-exposure'
import { isCompleteExposure, loadDependencyExposure, type DependencyExposure } from '../dependency-exposure-load'

function describeInstance(instance: DependencyInstance): string[] {
  const facts = [
    instance.direct ? `declared as ${instance.declaredAs.join(', ')}` : `depth ${instance.depth}`,
    instance.installedInProduction ? 'installed in production' : 'not installed by `bun install --production`',
  ]
  const aliases = instance.installedAs.filter((alias) => alias !== instance.name)
  if (aliases.length > 0) facts.unshift(`installed as ${aliases.join(', ')}`)
  const lines = [`${instance.id} (${facts.join('; ')})`]
  for (const [direct, path] of Object.entries(instance.paths).sort(([a], [b]) => a.localeCompare(b))) {
    if (path.length > 1) lines.push(`  via ${direct}: ${path.join(' > ')}`)
  }
  return lines
}

export function renderDepsWhy(name: string, tree: LoadedDependencyTree, matches: readonly DependencyInstance[]): string {
  const lines: string[] = []
  if (tree.coverage.status === 'unavailable') {
    lines.push(...tree.coverage.reasons.map((reason) => reason.message))
    return lines.join('\n')
  }
  if (matches.length === 0) {
    lines.push(`${name} is not installed in this app (${tree.lockfile}).`)
  } else {
    lines.push(`${name}: ${matches.length} installed ${matches.length === 1 ? 'version' : 'versions'} (${tree.lockfile})`)
    for (const instance of matches) lines.push('', ...describeInstance(instance))
  }
  if (tree.coverage.status === 'partial') {
    lines.push('', 'The tree is incomplete, so a path may be missing:', ...tree.coverage.reasons.map((reason) => `  ${reason.message}`))
  }
  return lines.join('\n')
}

export const depsWhyCommand = defineCommand({
  meta: { name: 'deps:why', description: 'Show every installed version of a package and the path each direct dependency brings it in by (RFC 0039).' },
  args: {
    name: { type: 'positional', required: true, description: 'Package name, e.g. hono or @inertiajs/react.' },
    json: { type: 'boolean', description: 'Print the matching tree entries and the coverage as JSON.' },
    app: { type: 'string', description: 'Application root directory.' },
  },
  async run({ args }) {
    const name = String(args.name)
    const tree = await loadDependencyTree(args.app ?? process.cwd())
    const matches = tree.packages.filter((instance) => instance.name === name || instance.installedAs.includes(name))
    if (tree.coverage.status !== 'complete' || matches.length === 0) markCommandFailed()
    console.log(args.json
      ? JSON.stringify({ schemaVersion: 1, lockfile: tree.lockfile, workspace: tree.workspace, coverage: tree.coverage, packages: matches })
      : renderDepsWhy(name, tree, matches))
  },
})

function describeExposure(entry: ExposedPackage): string[] {
  const where = entry.placement.map((placement) => placement.at).join(', ') || 'not imported by the app'
  const lines = [`${entry.id} (${entry.attribution}; ${where})`]
  if (entry.note) lines.push(`  ${entry.note}`)
  for (const route of entry.routes) {
    lines.push(`  ${route.method} ${route.path}${route.name ? ` (${route.name})` : ''}${route.authentication === 'required' ? ', signed in' : ''}`)
  }
  for (const site of entry.importedBy) {
    const from = [...new Set([...site.entries, ...site.nodes.map((node) => node.chain[0]!)])]
    lines.push(`  imported as ${site.imports} by ${site.file}:${site.line}${from.length > 0 ? `, reached from ${from.join(', ')}` : ''}`)
  }
  return lines
}

export function renderDepsExposure(exposure: DependencyExposure, filter: string | undefined): string {
  const lines: string[] = []
  const shown = filter === undefined
    ? exposure.packages.filter((entry) => entry.importedBy.length > 0)
    : exposure.packages.filter((entry) => (entry.name === filter || entry.installedAs.includes(filter)))
  if (filter === undefined) {
    const framework = exposure.packages.filter((entry) => entry.attribution === 'framework').length
    lines.push(`${exposure.packages.length} installed packages (${exposure.lockfile ?? 'no lockfile'}); ${shown.length} imported by the app, ${framework} brought in only by @guren packages.`)
  } else if (shown.length === 0) {
    lines.push(`${filter} is not installed in this app.`)
  }
  for (const entry of shown) lines.push('', ...describeExposure(entry))
  const incomplete = Object.entries(exposure.coverage).filter(([key, coverage]) => key !== 'runtime' && coverage.status !== 'complete')
  if (incomplete.length > 0 || exposure.snapshot.consistency === 'changed') {
    lines.push('', 'Incomplete, so a route or an import may be missing:')
    if (exposure.snapshot.consistency === 'changed') lines.push('  files changed while they were read')
    for (const [key, coverage] of incomplete) {
      for (const reason of coverage.reasons) lines.push(`  ${key}: ${reason.message}`)
    }
  }
  return lines.join('\n')
}

export const depsExposureCommand = defineCommand({
  meta: { name: 'deps:exposure', description: 'Show which routes and files reach each installed package, through imports and the Application Graph (RFC 0039).' },
  args: {
    package: { type: 'string', description: 'Only this package, e.g. hono.' },
    json: { type: 'boolean', description: 'Print the versioned exposure document.' },
    app: { type: 'string', description: 'Application root directory.' },
    introspect: { type: 'boolean', default: true, description: 'Disable registration introspection with --no-introspect.' },
  },
  async run({ args }) {
    let exposure: DependencyExposure
    try {
      exposure = await loadDependencyExposure({ cwd: args.app ?? process.cwd(), introspect: args.introspect !== false })
    } catch (error) {
      markCommandFailed()
      const message = `Dependency exposure could not be collected (${error instanceof Error ? error.message : String(error)}).`
      console.log(args.json ? JSON.stringify({ schemaVersion: 1, error: { code: 'collection-failed', message } }) : message)
      return
    }
    const filter = args.package === undefined ? undefined : String(args.package)
    const document = filter === undefined
      ? exposure
      : { ...exposure, packages: exposure.packages.filter((entry) => (entry.name === filter || entry.installedAs.includes(filter))) }
    if (!isCompleteExposure(exposure) || (filter !== undefined && document.packages.length === 0)) markCommandFailed()
    console.log(args.json ? JSON.stringify(document) : renderDepsExposure(exposure, filter))
  },
})
