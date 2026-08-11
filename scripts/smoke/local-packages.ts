/**
 * The one rule for which `@guren/*` packages a smoke run must resolve from this
 * checkout instead of from npm, and the vendoring that applies it.
 *
 * Every smoke that installs a scaffolded app needs the same set, and each copy
 * of it was a way for a package to miss a gate: `@guren/testing` was absent from
 * two of the three lists, so `smoke:starter` and `smoke:golden-path` quietly
 * resolved it from the registry and never exercised anything added to
 * `packages/testing` since its last release. Nothing failed until a release
 * bumped it to a version npm did not have.
 *
 * So the list is not written down here either. It is derived: seed from the
 * `@guren/*` dependencies the scaffold templates declare — a scaffolded app can
 * only resolve what its own manifest names — then close over the workspace
 * dependency graph, because whatever those packages pull in resolves from the
 * app's `node_modules` too. Adding a package to the workspace enters the smokes
 * the moment a template depends on it, and never before.
 *
 * `assertLocalGurenDependencies()` is what makes that derivation safe to trust:
 * it re-reads the manifest a smoke just rewrote and fails on any `@guren/*`
 * entry still carrying a registry range, whatever the seed produced.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { TEMPLATES_ROOT, templateManifests } from '../../packages/create-app/src/blueprints'
import { collectPackages, repoRoot, type WorkspacePackage } from '../workspace-packages'

/**
 * Every group a manifest can declare a dependency in — the same four
 * `guren upgrade` rewrites. Rewriting and checking read the same list on
 * purpose: a group one of them skipped would be a place for a dependency to
 * keep its registry range while the post-condition still passed.
 */
export const DEPENDENCY_GROUPS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

export type DependencyGroup = (typeof DEPENDENCY_GROUPS)[number]

export type DependencyManifest = Partial<Record<DependencyGroup, Record<string, string>>>

export interface LocalPackage {
  /** Package name as an app declares it, e.g. `@guren/testing`. */
  name: string
  /** Directory under `packages/`, and the directory a vendored copy lands in. */
  dirName: string
  /** Absolute path to the package in this checkout. */
  sourceDir: string
}

/**
 * Does this specifier resolve to a path in this checkout rather than to the
 * registry? Deliberately narrower than `isLocationSpecifier()` in
 * `packages/cli/src/codemods.ts`, which also counts `npm:`, `git:` and
 * `github:` as locations — for that question they are, for this one they are
 * exactly the failure being checked for.
 */
export function isLocalSpecifier(range: string): boolean {
  return /^(?:file|link|workspace|portal):|^[./]/u.test(range)
}

/** Every dependency a manifest declares, across all groups. */
export function declaredDependencies(manifest: DependencyManifest): Record<string, string> {
  return Object.assign({}, ...DEPENDENCY_GROUPS.map((group) => manifest[group])) as Record<string, string>
}

async function readManifest(dir: string): Promise<DependencyManifest> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as DependencyManifest
}

async function writeManifest(dir: string, manifest: DependencyManifest): Promise<void> {
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** The `@guren/*` names the scaffold templates declare, in any dependency group. */
async function templateDependencies(): Promise<Set<string>> {
  const names = new Set<string>()

  for (const path of await templateManifests()) {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as DependencyManifest
    for (const name of Object.keys(declaredDependencies(manifest))) {
      if (name.startsWith('@guren/')) {
        names.add(name)
      }
    }
  }

  return names
}

let cached: Promise<LocalPackage[]> | undefined

/**
 * The packages a scaffolded app resolves from this checkout: what the templates
 * declare, plus everything those packages depend on inside the workspace.
 */
export function collectLocalPackages(): Promise<LocalPackage[]> {
  cached ??= (async () => {
    const workspace = new Map((await collectPackages()).map((pkg) => [pkg.name, pkg]))
    const seed = await templateDependencies()

    // A template naming a package this workspace does not have cannot be
    // vendored, and installing it from npm is the failure this module exists to
    // prevent — so say which one rather than quietly shipping a shorter list.
    const unknown = [...seed].filter((name) => !workspace.has(name))
    if (unknown.length > 0) {
      throw new Error(
        `${relative(repoRoot, TEMPLATES_ROOT)} depends on ${unknown.join(', ')}, which this workspace ` +
        'has no package for. A smoke cannot point that dependency at this checkout, so it would install ' +
        'from npm and gate nothing.',
      )
    }

    // Reachability, not build order: `dependencySchedule()` in
    // workspace-packages.ts drops the core↔cli edge to break that cycle, and a
    // vendor set missing either side of it would resolve the other from npm.
    // Note the traversal follows `dependencies` + `peerDependencies` (what
    // WorkspacePackage carries), which is what an install actually pulls in.
    const selected = new Map<string, WorkspacePackage>()
    const queue = [...seed]
    while (queue.length > 0) {
      const name = queue.shift()!
      if (selected.has(name)) {
        continue
      }
      const pkg = workspace.get(name)
      if (!pkg) {
        continue // Not ours to vendor — react, hono, drizzle-orm and friends.
      }
      selected.set(name, pkg)
      queue.push(...pkg.dependencies)
    }

    return [...selected.values()]
      .map((pkg) => ({ name: pkg.name, dirName: pkg.dirName, sourceDir: pkg.dir }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })()

  return cached
}

/**
 * Fail before a smoke scaffolds anything if the checkout is unbuilt — the
 * vendored copies are `dist/` and nothing else, so a missing build reads as a
 * broken framework several minutes later.
 */
export async function ensureBuiltPackages(): Promise<void> {
  for (const pkg of await collectLocalPackages()) {
    if (!(await Bun.file(join(pkg.sourceDir, 'dist/index.js')).exists())) {
      throw new Error(`Missing build output for ${pkg.name}. Run bun run build first.`)
    }

    if (pkg.name === '@guren/core') {
      const manifest = JSON.parse(await readFile(join(pkg.sourceDir, 'package.json'), 'utf8')) as {
        exports?: Record<string, unknown>
      }
      for (const subpath of ['./runtime', './vite']) {
        if (!manifest.exports?.[subpath]) {
          throw new Error(`${pkg.name} is missing the ${subpath} export in package.json.`)
        }
      }
    }
  }
}

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/')
}

function localSpecifier(fromDir: string, target: string): string {
  return `file:${toPosixPath(relative(fromDir, target)) || '.'}`
}

/**
 * Copy each package's `dist/` and manifest into `vendorRoot`, with their
 * cross-references pointed at each other. Returns where each package landed.
 */
export async function vendorLocalPackages(vendorRoot: string): Promise<Map<string, string>> {
  const packages = await collectLocalPackages()
  const roots = new Map(packages.map((pkg) => [pkg.name, join(vendorRoot, pkg.dirName)]))

  for (const pkg of packages) {
    const destination = roots.get(pkg.name)!
    await mkdir(destination, { recursive: true })
    await cp(join(pkg.sourceDir, 'dist'), join(destination, 'dist'), { recursive: true, force: true })

    const manifest = await readManifest(pkg.sourceDir)
    for (const group of DEPENDENCY_GROUPS) {
      for (const name of Object.keys(manifest[group] ?? {})) {
        const target = roots.get(name)
        if (target) {
          manifest[group]![name] = localSpecifier(destination, target)
        }
      }
    }
    await writeManifest(destination, manifest)
  }

  return roots
}

/**
 * Point a scaffolded app's `@guren/*` dependencies at `roots` — vendored
 * directories or packed tarballs, whichever the caller produced — and assert
 * afterwards that none was left resolving from npm.
 */
export async function rewriteAppDependencies(
  appDir: string,
  roots: Map<string, string>,
  context = 'The rewritten app',
): Promise<void> {
  const manifest = await readManifest(appDir)

  for (const [name, target] of roots) {
    const specifier = localSpecifier(appDir, target)
    // Rewrite the entry where the template already declares it — `@guren/testing`
    // is a devDependency. Adding it to `dependencies` instead would leave the
    // template's own range in `devDependencies`, and bun still resolves that
    // range against the registry, where an unreleased version does not exist.
    const group = DEPENDENCY_GROUPS.find((field) => manifest[field]?.[name])
    if (group) {
      manifest[group]![name] = specifier
      continue
    }
    // Undeclared by the template — `@guren/server` arrives through `@guren/core`.
    // Naming it directly is what hoists it into `node_modules/@guren/*`.
    manifest.dependencies ??= {}
    manifest.dependencies[name] = specifier
  }

  await writeManifest(appDir, manifest)
  await assertLocalGurenDependencies(appDir, context)
}

/**
 * The post-condition every smoke that rewrites a manifest has to pass: no
 * `@guren/*` dependency is left resolving from npm.
 *
 * The derived list above is only as good as its derivation, and the failure it
 * guards against is silent — a package that keeps its published range installs
 * fine and gates nothing. This reads the rewritten manifest instead of trusting
 * the list, so a template or fixture that grows a dependency the vendor set does
 * not cover fails here, by name.
 */
export async function assertLocalGurenDependencies(appDir: string, context: string): Promise<void> {
  const manifest = await readManifest(appDir)

  const registryRanges: string[] = []
  for (const group of DEPENDENCY_GROUPS) {
    for (const [name, range] of Object.entries(manifest[group] ?? {})) {
      if (name.startsWith('@guren/') && !isLocalSpecifier(range)) {
        registryRanges.push(`${group}.${name} (${range})`)
      }
    }
  }

  if (registryRanges.length > 0) {
    throw new Error(
      `${context} still resolves ${registryRanges.join(', ')} from npm.\n` +
      'Every @guren/* dependency has to point at this checkout, or the smoke installs a published\n' +
      'copy and gates nothing that changed since its release. See scripts/smoke/local-packages.ts.',
    )
  }
}

/**
 * CLI face, for `scripts/smoke-golden-path.sh` — bash holds no copy of the list.
 */
async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv

  switch (command) {
    case 'ensure-built': {
      await ensureBuiltPackages()
      const packages = await collectLocalPackages()
      console.log(`All packages have build output: ${packages.map((pkg) => pkg.name).join(', ')}`)
      return
    }
    case 'vendor': {
      const [appDir, vendorRoot] = args
      if (!appDir || !vendorRoot) {
        throw new Error('Usage: local-packages.ts vendor <appDir> <vendorRoot>')
      }
      await ensureBuiltPackages()
      const roots = await vendorLocalPackages(resolve(vendorRoot))
      for (const name of roots.keys()) {
        console.log(`  Vendored ${name}`)
      }
      await rewriteAppDependencies(resolve(appDir), roots)
      console.log('  Rewrote dependency references to vendored paths.')
      return
    }
    default:
      throw new Error(`Unknown command "${command ?? ''}". Expected one of: ensure-built, vendor.`)
  }
}

if (import.meta.path === Bun.main) {
  await main(process.argv.slice(2))
}
