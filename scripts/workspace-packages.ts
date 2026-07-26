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

export async function collectPackages(): Promise<WorkspacePackage[]> {
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const packages: WorkspacePackage[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const dir = join(packagesDir, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!(await Bun.file(manifestPath).exists())) continue

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      name?: string
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
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

  const pending = new Map(
    packages.map((pkg) => [
      pkg.name,
      new Set(
        pkg.dependencies.filter(
          (dep) => byName.has(dep) && !ignored.has(`${pkg.name} ${dep}`),
        ),
      ),
    ]),
  )

  const ordered: WorkspacePackage[] = []

  while (ordered.length < packages.length) {
    const ready = packages.filter(
      (pkg) => pending.has(pkg.name) && pending.get(pkg.name)!.size === 0,
    )

    if (ready.length === 0) {
      const remaining = [...pending.keys()].join(', ')
      throw new Error(
        `Dependency cycle between workspace packages: ${remaining}. ` +
          'Add the offending edge to ignoredEdges in scripts/workspace-packages.ts.',
      )
    }

    for (const pkg of ready) {
      ordered.push(pkg)
      pending.delete(pkg.name)
      for (const remaining of pending.values()) remaining.delete(pkg.name)
    }
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
