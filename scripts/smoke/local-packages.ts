/**
 * The one rule for which `@guren/*` packages a smoke run resolves from this
 * checkout instead of npm, and the vendoring that applies it.
 * The set is derived, never listed: seed from the `@guren/*` the templates
 * declare, then close over the workspace graph (a hand-kept list left
 * `@guren/testing` out of two smokes, which then verified the published copy).
 * Vendored copies install as tarballs, never `file:<directory>`: on Bun 1.3.14 a
 * directory dependency spins `bun audit` and any later `bun add` at 100% CPU
 * (40 s cap hit; a tarball or registry install answers in 0.3 s).
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { TEMPLATES_ROOT, templateManifests } from '../../packages/create-app/src/blueprints'
import { collectPackages, repoRoot, type WorkspacePackage } from '../workspace-packages'

/**
 * Every group a manifest can declare a dependency in — the same four
 * `guren upgrade` rewrites. Rewriting and checking read the same list: a group
 * one of them skipped would let a registry range survive the post-condition.
 */
export const DEPENDENCY_GROUPS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

export type DependencyGroup = (typeof DEPENDENCY_GROUPS)[number]

export type DependencyManifest = Partial<Record<DependencyGroup, Record<string, string>>> & {
  files?: string[]
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

export interface LocalPackage {
  /** Package name as an app declares it, e.g. `@guren/testing`. */
  name: string
  /** Directory under `packages/`, and the directory a vendored copy is staged in before packing. */
  dirName: string
  /** Absolute path to the package in this checkout. */
  sourceDir: string
  /** The manifest version, which the vendored tarballs pin each other to. */
  version: string
}

/**
 * Does this specifier resolve to a path in this checkout rather than to the
 * registry? Narrower than `isLocationSpecifier()` in
 * `packages/cli/src/codemods.ts`: `npm:`, `git:` and `github:` are locations
 * there, and exactly the failure being checked for here.
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

    // Naming the package rather than quietly shipping a shorter vendor set.
    const unknown = [...seed].filter((name) => !workspace.has(name))
    if (unknown.length > 0) {
      throw new Error(
        `${relative(repoRoot, TEMPLATES_ROOT)} depends on ${unknown.join(', ')}, which this workspace ` +
        'has no package for. A smoke cannot point that dependency at this checkout, so it would install ' +
        'from npm and gate nothing.',
      )
    }

    // Reachability, not build order: `dependencySchedule()` drops the core↔cli
    // edge to break that cycle, and a vendor set missing either side of it would
    // resolve the other from npm. Follows dependencies + peerDependencies.
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
      .map((pkg) => {
        if (!pkg.version) {
          throw new Error(`${pkg.name} declares no version; the vendored tarballs cannot pin each other to it.`)
        }
        return { name: pkg.name, dirName: pkg.dirName, sourceDir: pkg.dir, version: pkg.version }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  })()

  return cached
}

/**
 * Fail before a smoke scaffolds anything if the checkout is unbuilt: the
 * vendored copies are `dist/` and nothing else, so a missing build otherwise
 * reads as a broken framework several minutes later.
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
 * Stage each package's manifest `files` (`dist/`, and the `templates/` an installed
 * `@guren/cli` reads) under `vendorRoot/<dirName>`, pack each into a tarball there,
 * and return the tarball per package name. Cross-references become exact-version
 * optional peers: a `dependencies` range nests a *registry* copy under the tarball,
 * and no reference drops the package from `guren audit`'s CSRF scan (it reads peers).
 */
export async function vendorLocalPackages(vendorRoot: string): Promise<Map<string, string>> {
  const packages = await collectLocalPackages()
  const versions = new Map(packages.map((pkg) => [pkg.name, pkg.version]))

  const tarballs = new Map<string, string>()
  for (const pkg of packages) {
    const staging = join(vendorRoot, pkg.dirName)
    await mkdir(staging, { recursive: true })
    const manifest = await readManifest(pkg.sourceDir)
    // Literal paths only, and every one of them present: a `files` glob or a
    // missing directory would otherwise pack a hollow tarball that fails later,
    // inside the app.
    if (!manifest.files) {
      throw new Error(`${pkg.name} declares no \`files\`; the smoke cannot tell what it ships.`)
    }
    for (const entry of manifest.files) {
      const source = join(pkg.sourceDir, entry)
      if (!(await stat(source).then(() => true, () => false))) {
        throw new Error(`${pkg.name} lists ${entry} in \`files\`, but ${source} does not exist.`)
      }
      await cp(source, join(staging, entry), { recursive: true, force: true })
    }

    const peers = (manifest.peerDependencies ??= {})
    const peersMeta = (manifest.peerDependenciesMeta ??= {})
    for (const group of DEPENDENCY_GROUPS) {
      for (const name of Object.keys(manifest[group] ?? {})) {
        const version = versions.get(name)
        if (version === undefined) {
          continue // Not ours — react, hono, drizzle-orm keep their ranges.
        }
        delete manifest[group]![name]
        peers[name] = version
        peersMeta[name] = { optional: true }
      }
    }
    await writeManifest(staging, manifest)
    tarballs.set(pkg.name, await packDirectory(staging, vendorRoot))
    await rm(staging, { recursive: true, force: true })
  }

  return tarballs
}

/**
 * After `bun install`: every vendored package resolves to exactly one copy, the
 * hoisted one, at the version this checkout carries. The optional-peer rewrite in
 * `vendorLocalPackages()` is what keeps bun from nesting a registry copy under a
 * tarball; this is the check that it did, since two `@guren/orm` in one process
 * fail minutes later as "database has not been configured".
 */
export async function assertSingleInstalledCopies(appDir: string): Promise<void> {
  const nodeModules = join(appDir, 'node_modules')
  const problems: string[] = []

  for (const pkg of await collectLocalPackages()) {
    const installed = await readManifest(join(nodeModules, pkg.name)).catch(() => null) as
      | (DependencyManifest & { version?: string })
      | null
    if (installed?.version !== pkg.version) {
      problems.push(`${pkg.name}: expected ${pkg.version} at node_modules/${pkg.name}, found ${installed?.version ?? 'nothing'}`)
    }
  }

  const nested = new Bun.Glob('**/node_modules/@guren/*/package.json')
  for await (const path of nested.scan({ cwd: nodeModules, onlyFiles: true })) {
    problems.push(`nested copy: node_modules/${path}`)
  }

  if (problems.length > 0) {
    throw new Error(
      `${appDir} does not resolve every @guren/* package to one vendored copy:\n` +
      problems.map((line) => `  ${line}`).join('\n'),
    )
  }
}

/** `bun pm pack` on a staged copy; returns the tarball's absolute path. */
async function packDirectory(packageDir: string, destination: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ['bun', 'pm', 'pack', '--destination', destination, '--quiet'],
    cwd: packageDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  // `--quiet` prints the tarball path, absolute when `--destination` is.
  const fileName = stdout.trim().split('\n').at(-1) ?? ''
  if (exitCode !== 0 || !fileName.endsWith('.tgz')) {
    throw new Error(`bun pm pack failed in ${packageDir} (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`)
  }
  return resolve(destination, fileName)
}

/**
 * Point a scaffolded app's `@guren/*` dependencies at `roots` — the tarballs
 * `vendorLocalPackages()` or `smoke:starter:packed` produced — and assert
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
    // Rewrite in the group the template declares it in (`@guren/testing` is a
    // devDependency): a second entry elsewhere leaves the original range, which
    // bun still resolves against the registry.
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
 * `@guren/*` dependency is left resolving from npm. Reads the rewritten
 * manifest rather than trusting the derived list, because the failure it guards
 * against is silent — a published range installs fine and gates nothing.
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

/** CLI face for `scripts/smoke-golden-path.sh` — bash holds no copy of the list. */
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
      for (const [name, tarball] of roots) {
        console.log(`  Vendored ${name} -> ${relative(resolve(appDir), tarball)}`)
      }
      await rewriteAppDependencies(resolve(appDir), roots)
      console.log('  Rewrote dependency references to vendored tarballs.')
      return
    }
    case 'assert-installed': {
      const [appDir] = args
      if (!appDir) {
        throw new Error('Usage: local-packages.ts assert-installed <appDir>')
      }
      await assertSingleInstalledCopies(resolve(appDir))
      console.log('  Every @guren/* package resolves to its one vendored copy.')
      return
    }
    default:
      throw new Error(`Unknown command "${command ?? ''}". Expected one of: ensure-built, vendor, assert-installed.`)
  }
}

if (import.meta.path === Bun.main) {
  await main(process.argv.slice(2))
}
