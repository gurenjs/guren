import { defineCommand } from '../define-command'
import { markCommandFailed } from '../command-status'
import { loadDependencyTree, type LoadedDependencyTree } from '../dependency-tree-load'
import type { DependencyInstance } from '../dependency-tree'

function describeInstance(instance: DependencyInstance): string[] {
  const facts = [
    instance.direct ? `declared as ${instance.declaredAs.join(', ')}` : `depth ${instance.depth}`,
    instance.installedInProduction ? 'installed in production' : 'not installed by `bun install --production`',
  ]
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
    const matches = tree.packages.filter((instance) => instance.name === name)
    if (tree.coverage.status !== 'complete' || matches.length === 0) markCommandFailed()
    console.log(args.json
      ? JSON.stringify({ schemaVersion: 1, lockfile: tree.lockfile, workspace: tree.workspace, coverage: tree.coverage, packages: matches })
      : renderDepsWhy(name, tree, matches))
  },
})
