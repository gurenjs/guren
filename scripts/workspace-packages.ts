// Shared reading of the workspace's package manifests.
//
// Two questions, both answered here so that no script answers either one twice:
//
// - which packages live under packages/, and in what order they depend on each
//   other. Used by scripts/build-packages.ts and scripts/test-packages.ts so
//   that adding a package (a plugin, for example) never requires editing a
//   hand-maintained list in the root package.json.
// - what a manifest said at a git rev, which is how the release gates in
//   scripts/ tell a version that moved from one that did not. `versionOf` is
//   the rule that a version nobody could read is *not* a version: a gate that
//   lets an unreadable manifest stand in for a number silently stops gating.
//   Only one of the two gates had reached that conclusion. The other compared
//   a bare `.version` against a bare `.version`, so an unreadable side read as
//   *the version moved* and exempted the release it existed to gate. The rule
//   lives here because a gate that reimplements it locally is how that
//   happened, not because two correct copies wanted deduplicating.

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const repoRoot = resolve(import.meta.dir, '..')
const packagesDir = join(repoRoot, 'packages')

export interface WorkspacePackage {
  name: string
  version?: string
  private?: boolean
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
      version?: string
      private?: boolean
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
      version: manifest.version,
      private: manifest.private,
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

/**
 * The text of `manifestPath` as of `rev`, or `undefined` when git could not
 * produce it there — the file did not exist at that commit, or the rev itself
 * does not resolve.
 *
 * Deliberately separate from `versionOf` rather than folded into one
 * `versionAtRev`: "there is no manifest at that rev" and "there is one and its
 * version cannot be read" are the same `undefined` to a caller that only wants
 * a version, and callers that must tell them apart would have no way back.
 *
 * `repo` is the checkout to read, not a test hook — a gate is only observable
 * against real commits, so its tests build throwaway repositories. It must be
 * the repository *root*: git resolves `<rev>:<path>` against the top of the
 * working tree whatever the cwd is (from packages/cli, `git show HEAD:package.json`
 * hands back the root manifest), while every caller pairs this with a
 * working-tree `join(repo, manifestPath)` that resolves against `repo`. Point
 * it at a subdirectory and the two sides read different files.
 */
export function manifestAtRev(rev: string, manifestPath: string, repo: string = repoRoot): string | undefined {
  const show = Bun.spawnSync(['git', 'show', `${rev}:${manifestPath}`], { cwd: repo })
  return show.success ? show.stdout.toString() : undefined
}

/**
 * The `version` a package manifest declares, or `undefined` when it declares
 * none this rule recognizes: unparseable JSON, an absent `version`, a
 * `version` that is not a string, or no manifest text at all.
 *
 * Every one of those collapses to `undefined` on purpose, and callers must
 * treat `undefined` as "unknown" rather than as a value. Comparing two
 * unknowns reads as "unchanged"; comparing one against a real version reads as
 * "moved". Both readings are wrong, and the second is the dangerous one — it
 * is a release gate exempting itself.
 */
export function versionOf(manifest: string | undefined): string | undefined {
  if (manifest === undefined) return undefined
  try {
    const version = (JSON.parse(manifest) as { version?: unknown }).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

// @guren/cli and @guren/core depend on each other, so the graph has one real
// cycle. Ignoring core's edge on cli pins cli after core, matching how the
// published packages resolve each other.
const ignoredEdges: Array<[dependent: string, dependency: string]> = [
  ['@guren/core', '@guren/cli'],
]

export interface DependencySchedule {
  /** Count of unsatisfied in-workspace dependencies per package name. */
  remainingDeps: Map<string, number>
  /** Packages waiting on each package name. */
  dependents: Map<string, WorkspacePackage[]>
}

/**
 * The Kahn bookkeeping shared by the topological sort and the parallel build
 * scheduler: in-workspace dependency counts and the reverse index, with
 * `ignoredEdges` removed. Returns fresh maps — callers mutate `remainingDeps`
 * as packages complete.
 *
 * When `closureThrough` is wider than `packages` (a subset selection), edges
 * are followed through the unselected packages, so `server` still orders
 * before `openapi` when `core` sits between them but is not selected.
 * Dependencies outside `closureThrough` entirely are treated as satisfied.
 */
export function dependencySchedule(
  packages: WorkspacePackage[],
  closureThrough: WorkspacePackage[] = packages,
): DependencySchedule {
  const selected = new Set(packages.map((pkg) => pkg.name))
  const byName = new Map(closureThrough.map((pkg) => [pkg.name, pkg]))
  const ignored = new Set(ignoredEdges.map(([from, to]) => `${from} ${to}`))

  const directDeps = (pkg: WorkspacePackage): string[] =>
    pkg.dependencies.filter(
      (dep) => byName.has(dep) && !ignored.has(`${pkg.name} ${dep}`),
    )

  const remainingDeps = new Map<string, number>()
  const dependents = new Map<string, WorkspacePackage[]>()

  for (const pkg of packages) {
    // BFS that stops at selected packages and traverses through unselected
    // ones. With closureThrough === packages every dependency is selected, so
    // this degenerates to the direct-edge case the sorter uses.
    const deps = new Set<string>()
    const visited = new Set<string>()
    const queue = directDeps(pkg)
    while (queue.length > 0) {
      const name = queue.shift()!
      if (visited.has(name)) continue
      visited.add(name)
      if (selected.has(name)) {
        deps.add(name)
        continue
      }
      queue.push(...directDeps(byName.get(name)!))
    }

    remainingDeps.set(pkg.name, deps.size)
    for (const dep of deps) {
      if (!dependents.has(dep)) dependents.set(dep, [])
      dependents.get(dep)!.push(pkg)
    }
  }

  return { remainingDeps, dependents }
}

export function sortByDependencies(
  packages: WorkspacePackage[],
): WorkspacePackage[] {
  // The stale check lives here rather than in dependencySchedule so it prints
  // once per run — every build/test entry point sorts before scheduling.
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  for (const [from, to] of ignoredEdges) {
    const dependent = byName.get(from)
    if (dependent && !dependent.dependencies.includes(to)) {
      console.warn(
        `[workspace] stale entry in ignoredEdges: ${from} no longer depends on ${to}`,
      )
    }
  }

  const { remainingDeps, dependents } = dependencySchedule(packages)

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
