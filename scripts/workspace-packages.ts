// Shared discovery for the workspace packages under packages/.
//
// Used by scripts/build-packages.ts and scripts/test-packages.ts so that adding
// a package (a plugin, for example) never requires editing a hand-maintained
// list in the root package.json.

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const repoRoot = resolve(import.meta.dir, '..')
const packagesDir = join(repoRoot, 'packages')

export interface WorkspacePackage {
  name: string
  dir: string
  dirName: string
  /** Path relative to the repo root, e.g. `packages/server`. */
  relativeDir: string
  scripts: Record<string, string>
  dependencies: string[]
}

/**
 * Splits argv into recognized boolean flags, everything after a bare `--`
 * (returned verbatim, for forwarding to a spawned process), and the remaining
 * positional arguments (package selectors).
 */
export function parseArgs(
  argv: string[],
  booleanFlags: string[],
): { flags: Record<string, boolean>; positionals: string[]; forwarded: string[] } {
  const separator = argv.indexOf('--')
  const ownArgs = separator === -1 ? argv : argv.slice(0, separator)
  const forwarded = separator === -1 ? [] : argv.slice(separator + 1)

  const flags: Record<string, boolean> = {}
  for (const flag of booleanFlags) flags[flag] = ownArgs.includes(`--${flag}`)

  const positionals: string[] = []
  for (const arg of ownArgs) {
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    if (!booleanFlags.includes(arg.slice(2))) {
      throw new Error(
        `Unknown flag: ${arg}. Recognized flags: ${booleanFlags.map((f) => `--${f}`).join(', ')}`,
      )
    }
  }

  return { flags, positionals, forwarded }
}

export async function collectPackages(): Promise<WorkspacePackage[]> {
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const packages: WorkspacePackage[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const dir = join(packagesDir, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!(await Bun.file(manifestPath).exists())) continue

    let manifest: {
      name?: string
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (cause) {
      throw new Error(`Failed to parse ${manifestPath}`, { cause })
    }

    if (!manifest.name) continue

    packages.push({
      name: manifest.name,
      dir,
      dirName: entry.name,
      relativeDir: `packages/${entry.name}`,
      scripts: manifest.scripts ?? {},
      dependencies: Object.keys({
        ...manifest.dependencies,
        ...manifest.peerDependencies,
      }),
    })
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name))
}

// @guren/cli and @guren/core depend on each other, so the graph has one real
// cycle. Ignoring core's edge on cli pins cli after core, matching how the
// published packages resolve each other.
const ignoredEdges: Array<[dependent: string, dependency: string]> = [
  ['@guren/core', '@guren/cli'],
]

export function sortByDependencies(
  packages: WorkspacePackage[],
): WorkspacePackage[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const ignored = new Set(ignoredEdges.map(([from, to]) => `${from} ${to}`))

  for (const [from, to] of ignoredEdges) {
    const dependent = byName.get(from)
    if (dependent && !dependent.dependencies.includes(to)) {
      console.warn(
        `[workspace] stale entry in ignoredEdges: ${from} no longer depends on ${to}`,
      )
    }
  }

  // Kahn's algorithm: track each package's remaining dependency count and the
  // set of packages waiting on it, so finishing one package only touches its
  // actual dependents instead of rescanning every still-pending package.
  const remainingDeps = new Map<string, number>()
  const dependents = new Map<string, WorkspacePackage[]>()

  for (const pkg of packages) {
    const deps = pkg.dependencies.filter(
      (dep) => byName.has(dep) && !ignored.has(`${pkg.name} ${dep}`),
    )
    remainingDeps.set(pkg.name, deps.length)
    for (const dep of deps) {
      if (!dependents.has(dep)) dependents.set(dep, [])
      dependents.get(dep)!.push(pkg)
    }
  }

  const queue = packages.filter((pkg) => remainingDeps.get(pkg.name) === 0)
  const ordered: WorkspacePackage[] = []

  while (queue.length > 0) {
    const pkg = queue.shift()!
    ordered.push(pkg)

    for (const dependent of dependents.get(pkg.name) ?? []) {
      const remaining = remainingDeps.get(dependent.name)! - 1
      remainingDeps.set(dependent.name, remaining)
      if (remaining === 0) queue.push(dependent)
    }
  }

  if (ordered.length < packages.length) {
    const remaining = packages
      .filter((pkg) => remainingDeps.get(pkg.name) !== 0)
      .map((pkg) => pkg.name)
      .join(', ')
    throw new Error(
      `Dependency cycle between workspace packages: ${remaining}. ` +
        'Add the offending edge to ignoredEdges in scripts/workspace-packages.ts.',
    )
  }

  return ordered
}

export function selectPackages(
  packages: WorkspacePackage[],
  selectors: string[],
): WorkspacePackage[] {
  if (selectors.length === 0) return packages

  const unknown = selectors.filter(
    (selector) =>
      !packages.some(
        (pkg) => selector === pkg.name || selector === pkg.dirName,
      ),
  )
  if (unknown.length > 0) {
    throw new Error(
      `Unknown package(s): ${unknown.join(', ')}. ` +
        `Available: ${packages.map((pkg) => pkg.dirName).join(', ')}`,
    )
  }

  return packages.filter((pkg) =>
    selectors.some(
      (selector) => selector === pkg.name || selector === pkg.dirName,
    ),
  )
}
