/**
 * Hold each `@guren/*` range floor to a release that carries what the dependent's
 * source imports from that package's subpaths, down to the export names: a named
 * import the installed copy lacks fails when the module links. Nothing else writes
 * a `>=` peer floor, since changesets leaves an in-range peer alone. Write mode runs
 * in `version-packages` right after `changeset version`, the first moment the
 * version a release introduces exists; `--check` backs `audit:import-floors`.
 * Exit 1 drift, 2 cannot run. Root entries are out of scope (see `ROOT_ENTRY`).
 */
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import process from 'node:process'
import { parse, type ParserPlugin } from '@babel/parser'
import type * as t from '@babel/types'
import { readChangesetDirectory } from './smoke/core-semver-audit'
import { plannedVersions } from './smoke/plugin-compat-audit'
import {
  collectPackages,
  manifestAtRev,
  parseArgs,
  repoRoot,
  versionOf,
  type WorkspacePackage,
} from './workspace-packages'

/** Only the groups a consumer installs; a stale devDependency pulls no copy. */
const DEPENDENCY_GROUPS = ['dependencies', 'peerDependencies'] as const
type DependencyGroup = (typeof DEPENDENCY_GROUPS)[number]

// Resolving a barrel at every admitted release is hundreds of files per version,
// and `@guren/core`'s root re-exports all of `@guren/server`'s. Subpath entries
// are a few files each, and are where cross-package internals are shared.
const ROOT_ENTRY = '.'

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx']
const TEST_FILE = /(\.test|\.spec)\.[cm]?[jt]sx?$|\/(__tests__|tests?|fixtures)\//

export class CannotJudge extends Error {}

/** A package as it was published at `version`; `rev: null` reads the working tree. */
interface Snapshot {
  version: string
  rev: string | null
}

interface Manifest {
  version?: string
  private?: boolean
  exports?: unknown
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** What one subpath of a snapshot exports. `open`: a star from outside the workspace. */
interface Surface {
  exists: boolean
  names: Set<string>
  open: boolean
}

interface ImportSite {
  file: string
  dependency: string
  subpath: string
  /** Value names bound from the entry; empty when only the subpath must resolve. */
  names: string[]
}

export interface Raise {
  manifestPath: string
  group: DependencyGroup
  dependency: string
  from: string
  to: string
  reason: string
}

export interface Pending {
  manifestPath: string
  group: DependencyGroup
  dependency: string
  range: string
  reason: string
}

export interface FloorPlan {
  raises: Raise[]
  pending: Pending[]
  drift: string[]
  edgesChecked: number
}

class Repository {
  private readonly texts = new Map<string, string | undefined>()
  private readonly histories = new Map<string, Snapshot[]>()

  constructor(readonly root: string) {}

  read(rev: string | null, path: string): string | undefined {
    const key = `${rev ?? ''}:${path}`
    if (!this.texts.has(key)) this.texts.set(key, rev === null ? this.readWorkingTree(path) : this.readAt(rev, path))
    return this.texts.get(key)
  }

  private readWorkingTree(path: string): string | undefined {
    try {
      return readFileSync(join(this.root, path), 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined
      throw error
    }
  }

  private readAt(rev: string, path: string): string | undefined {
    const show = Bun.spawnSync(['git', 'cat-file', 'blob', `${rev}:${path}`], { cwd: this.root })
    return show.success ? show.stdout.toString() : undefined
  }

  /**
   * Every version the package's manifest declared, ascending, each read at the
   * first commit declaring it: the version commit is what publishing tags, so an
   * export added after it is attributed to the next version (a higher floor).
   */
  releases(relativeDir: string): Snapshot[] {
    const cached = this.histories.get(relativeDir)
    if (cached) return cached

    const manifestPath = `${relativeDir}/package.json`
    const log = Bun.spawnSync(['git', 'log', '--topo-order', '--reverse', '--format=%H', '--', manifestPath], {
      cwd: this.root,
    })
    if (!log.success) throw new CannotJudge(`git log failed for ${manifestPath}: ${log.stderr.toString().trim()}`)

    const seen = new Set<string>()
    const releases: Snapshot[] = []
    for (const rev of log.stdout.toString().split('\n').filter(Boolean)) {
      const version = versionOf(this.read(rev, manifestPath))
      if (version === undefined || seen.has(version) || !Bun.semver.satisfies(version, '*')) continue
      seen.add(version)
      releases.push({ version, rev })
    }
    releases.sort((a, b) => Bun.semver.order(a.version, b.version))
    this.histories.set(relativeDir, releases)
    return releases
  }

  assertFullHistory(): void {
    const shallow = Bun.spawnSync(['git', 'rev-parse', '--is-shallow-repository'], { cwd: this.root })
    if (!shallow.success) {
      throw new CannotJudge(`git could not read ${this.root}, where releases are read from: ${shallow.stderr.toString().trim()}`)
    }
    if (shallow.stdout.toString().trim() === 'true') {
      throw new CannotJudge(
        'This clone is shallow, so the releases each floor admits cannot be read from history. ' +
          'Check out with `fetch-depth: 0`.',
      )
    }
  }
}

function parseModule(code: string, file: string): t.File {
  const plugins: ParserPlugin[] = ['typescript', 'decorators', 'decoratorAutoAccessors']
  if (file.endsWith('x')) plugins.push('jsx')
  try {
    return parse(code, { sourceType: 'module', sourceFilename: file, plugins })
  } catch (cause) {
    throw new CannotJudge(`Could not parse ${file}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

function exportedName(node: t.Identifier | t.StringLiteral): string {
  return node.type === 'Identifier' ? node.name : node.value
}

function bindingNames(pattern: t.LVal | t.PatternLike | null | undefined, into: Set<string>): void {
  if (!pattern) return
  if (pattern.type === 'Identifier') into.add(pattern.name)
  else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      bindingNames(property.type === 'RestElement' ? property.argument : (property.value as t.PatternLike), into)
    }
  } else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements) bindingNames(element, into)
  else if (pattern.type === 'RestElement') bindingNames(pattern.argument, into)
  else if (pattern.type === 'AssignmentPattern') bindingNames(pattern.left, into)
}

/** `@guren/server/internal/request` -> `['@guren/server', './internal/request']`. */
function splitSpecifier(specifier: string): [string, string] | null {
  const match = /^(@guren\/[^/]+)(?:\/(.+))?$/.exec(specifier)
  if (!match) return null
  return [match[1]!, match[2] ? `./${match[2]}` : ROOT_ENTRY]
}

/** The file an `exports` entry loads at runtime, or `undefined` when it names none. */
function exportTarget(exports: unknown, subpath: string): string | 'pattern' | undefined {
  if (exports === undefined || exports === null) return undefined
  const map =
    typeof exports === 'string' || !Object.keys(exports as object).some((key) => key.startsWith('.'))
      ? { [ROOT_ENTRY]: exports }
      : (exports as Record<string, unknown>)

  const pick = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object') return undefined
    const conditions = value as Record<string, unknown>
    for (const condition of ['bun', 'import', 'node', 'default']) {
      const picked = pick(conditions[condition])
      if (picked) return picked
    }
    return undefined
  }

  if (subpath in map) return pick(map[subpath])
  return Object.keys(map).some((key) => key.includes('*') && subpath.startsWith(key.slice(0, key.indexOf('*'))))
    ? 'pattern'
    : undefined
}

function withoutScriptExtension(path: string): string {
  return path.replace(/\.[cm]?jsx?$/, '')
}

class SurfaceReader {
  private readonly surfaces = new Map<string, Surface>()
  private readonly modules = new Map<string, Surface>()

  constructor(
    private readonly repo: Repository,
    private readonly packages: ReadonlyMap<string, WorkspacePackage>,
  ) {}

  manifest(pkg: WorkspacePackage, snapshot: Snapshot): Manifest {
    const path = `${pkg.relativeDir}/package.json`
    const text = this.repo.read(snapshot.rev, path)
    try {
      return JSON.parse(text ?? '') as Manifest
    } catch {
      throw new CannotJudge(`${path} is unreadable at ${snapshot.rev ?? 'the working tree'} (${pkg.name} ${snapshot.version}).`)
    }
  }

  surface(pkg: WorkspacePackage, snapshot: Snapshot, subpath: string): Surface {
    const key = `${pkg.name}@${snapshot.rev ?? ''}#${subpath}`
    let surface = this.surfaces.get(key)
    if (!surface) {
      surface = this.readSurface(pkg, snapshot, subpath)
      this.surfaces.set(key, surface)
    }
    return surface
  }

  private readSurface(pkg: WorkspacePackage, snapshot: Snapshot, subpath: string): Surface {
    const manifest = this.manifest(pkg, snapshot)
    const target = exportTarget(manifest.exports, subpath)
    if (target === undefined) return { exists: false, names: new Set(), open: false }
    if (target === 'pattern') return { exists: true, names: new Set(), open: true }

    const base = withoutScriptExtension(posix.normalize(target)).replace(/^dist\//, 'src/')
    const source = this.resolveFile(snapshot.rev, `${pkg.relativeDir}/${base}`)
    if (!base.startsWith('src/') || !source) {
      throw new CannotJudge(
        `${pkg.name} ${snapshot.version} exports ${subpath} as ${target}, which maps to no source file under ` +
          `${pkg.relativeDir}/src, so its export names cannot be read.`,
      )
    }
    return this.moduleExports(pkg, snapshot, manifest, source, new Set())
  }

  private resolveFile(rev: string | null, base: string): string | undefined {
    return SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`).find((path) => this.repo.read(rev, path) !== undefined)
  }

  private moduleExports(
    pkg: WorkspacePackage,
    snapshot: Snapshot,
    manifest: Manifest,
    file: string,
    visiting: Set<string>,
  ): Surface {
    const key = `${snapshot.rev ?? ''}:${file}`
    const cached = this.modules.get(key)
    if (cached) return cached
    if (visiting.has(file)) return { exists: true, names: new Set(), open: false }
    visiting.add(file)

    const names = new Set<string>()
    let open = false
    const program = parseModule(this.repo.read(snapshot.rev, file)!, file).program

    const star = (specifier: string): void => {
      const reexported = this.starSurface(pkg, snapshot, manifest, file, specifier, visiting)
      open ||= reexported.open
      for (const name of reexported.names) if (name !== 'default') names.add(name)
    }

    for (const statement of program.body) {
      if (statement.type === 'ExportAllDeclaration') {
        if (statement.exportKind !== 'type') star(statement.source.value)
      } else if (statement.type === 'ExportDefaultDeclaration') {
        names.add('default')
      } else if (statement.type === 'ExportNamedDeclaration' && statement.exportKind !== 'type') {
        const declaration = statement.declaration
        if (declaration && !('declare' in declaration && declaration.declare)) {
          if (declaration.type === 'VariableDeclaration') {
            for (const declarator of declaration.declarations) bindingNames(declarator.id, names)
          } else if (
            (declaration.type === 'FunctionDeclaration' ||
              declaration.type === 'ClassDeclaration' ||
              declaration.type === 'TSEnumDeclaration') &&
            declaration.id
          ) {
            names.add(declaration.id.name)
          }
        }
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ExportSpecifier' && specifier.exportKind === 'type') continue
          names.add(exportedName(specifier.exported))
        }
      }
    }

    const surface = { exists: true, names, open }
    this.modules.set(key, surface)
    return surface
  }

  private starSurface(
    pkg: WorkspacePackage,
    snapshot: Snapshot,
    manifest: Manifest,
    file: string,
    specifier: string,
    visiting: Set<string>,
  ): Surface {
    if (specifier.startsWith('.')) {
      const target = this.resolveFile(snapshot.rev, withoutScriptExtension(posix.join(posix.dirname(file), specifier)))
      if (!target) throw new CannotJudge(`${file} re-exports ${specifier}, which resolves to no file at ${snapshot.rev ?? 'the working tree'}.`)
      return this.moduleExports(pkg, snapshot, manifest, target, visiting)
    }

    const split = splitSpecifier(specifier)
    const dependency = split && this.packages.get(split[0])
    if (!split || !dependency) return { exists: true, names: new Set(), open: true }

    // What this release re-exports depends on which copy the consumer installed;
    // the lowest its own range admits is the one that can lack a name.
    const range = manifest.dependencies?.[split[0]] ?? manifest.peerDependencies?.[split[0]]
    const lowest = range ? admittedSnapshots(this.repo, dependency, range)[0] : undefined
    if (!lowest) {
      throw new CannotJudge(
        `${file} (${pkg.name} ${snapshot.version}) re-exports ${specifier}, but no release of ${split[0]} ` +
          `satisfies its declared range ${JSON.stringify(range)}.`,
      )
    }
    return this.surface(dependency, lowest, split[1])
  }
}

/** Every release `range` admits, ascending, plus a working tree carrying an unrecorded version. */
function admittedSnapshots(repo: Repository, pkg: WorkspacePackage, range: string): Snapshot[] {
  const releases = repo.releases(pkg.relativeDir)
  const admitted = releases.filter((release) => Bun.semver.satisfies(release.version, range))
  const workingTree = pkg.version
  if (workingTree && !releases.some((release) => release.version === workingTree) && Bun.semver.satisfies(workingTree, range)) {
    admitted.push({ version: workingTree, rev: null })
  }
  return admitted
}

function importSites(file: string, relativeFile: string): ImportSite[] {
  const program = parseModule(readFileSync(file, 'utf8'), relativeFile).program
  const sites: ImportSite[] = []

  const add = (specifier: string, names: string[]): void => {
    const split = splitSpecifier(specifier)
    if (split) sites.push({ file: relativeFile, dependency: split[0], subpath: split[1], names })
  }

  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type') {
      const names: string[] = []
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportDefaultSpecifier') names.push('default')
        else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') names.push(exportedName(specifier.imported))
      }
      add(statement.source.value, names)
    } else if (statement.type === 'ExportNamedDeclaration' && statement.source && statement.exportKind !== 'type') {
      const names: string[] = []
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ExportSpecifier' && specifier.exportKind !== 'type') names.push(exportedName(specifier.local))
      }
      add(statement.source.value, names)
    } else if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') {
      add(statement.source.value, [])
    }
  }

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    const candidate = node as { type?: string; callee?: { type?: string }; arguments?: t.Node[]; source?: t.Node }
    if (candidate.type === 'CallExpression' && candidate.callee?.type === 'Import') {
      const argument = candidate.arguments?.[0]
      if (argument?.type === 'StringLiteral') add(argument.value, [])
    } else if (candidate.type === 'ImportExpression' && candidate.source?.type === 'StringLiteral') {
      add(candidate.source.value, [])
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'loc' && key !== 'start' && key !== 'end' && typeof value === 'object') visit(value)
    }
  }
  visit(program)

  return sites
}

async function sourceFiles(pkg: WorkspacePackage): Promise<string[]> {
  const files: string[] = []
  for await (const path of new Bun.Glob('src/**/*.{ts,tsx,mts,js,mjs}').scan({ cwd: pkg.dir })) {
    if (!TEST_FILE.test(`/${path}`) && !path.endsWith('.d.ts')) files.push(path)
  }
  return files.sort()
}

interface Requirement {
  subpath: string
  names: Set<string>
  files: Set<string>
}

/** What `snapshot` lacks of `requirements`, as readable fragments; empty when it carries all. */
function lacking(reader: SurfaceReader, pkg: WorkspacePackage, snapshot: Snapshot, requirements: Requirement[]): string[] {
  const gaps: string[] = []
  for (const requirement of requirements) {
    const surface = reader.surface(pkg, snapshot, requirement.subpath)
    if (!surface.exists) {
      gaps.push(`no ${requirement.subpath} subpath`)
      continue
    }
    const missing = [...requirement.names].filter((name) => !surface.names.has(name))
    if (missing.length === 0) continue
    if (surface.open) {
      throw new CannotJudge(
        `${pkg.name} ${snapshot.version} ${requirement.subpath} re-exports a module outside this workspace, so ` +
          `whether it provides ${missing.join(', ')} cannot be read from source.`,
      )
    }
    gaps.push(`${requirement.subpath} without ${missing.join(', ')}`)
  }
  return gaps
}

const RANGE = /^(>=|\^|~)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

function raisedRange(range: string, to: string, workspaceVersion: string | undefined): string | null {
  const match = RANGE.exec(range.trim())
  if (!match) return null
  const [, operator = '', floor] = match
  const next = `${operator}${to}`
  const [floorMajor, floorMinor] = floor!.split('.')
  const [toMajor, toMinor] = to.split('.')
  if (operator === '^' && floorMajor !== toMajor) return null
  if (operator === '~' && (floorMajor !== toMajor || floorMinor !== toMinor)) return null
  if (operator === '' || (workspaceVersion && !Bun.semver.satisfies(workspaceVersion, next))) return null
  return next
}

export async function planImportFloors(root: string = repoRoot): Promise<FloorPlan> {
  const repo = new Repository(root)
  repo.assertFullHistory()

  const workspace = await collectPackages(root)
  const byName = new Map(workspace.map((pkg) => [pkg.name, pkg]))
  const reader = new SurfaceReader(repo, byName)
  const plan: FloorPlan = { raises: [], pending: [], drift: [], edgesChecked: 0 }

  for (const pkg of workspace) {
    if (pkg.private) continue
    const manifestPath = `${pkg.relativeDir}/package.json`
    const manifest = JSON.parse(await readFile(join(root, manifestPath), 'utf8')) as Manifest

    const byDependency = new Map<string, Map<string, Requirement>>()
    for (const file of await sourceFiles(pkg)) {
      for (const site of importSites(join(pkg.dir, file), `${pkg.relativeDir}/${file}`)) {
        if (site.dependency === pkg.name || site.subpath === ROOT_ENTRY || !byName.has(site.dependency)) continue
        const requirements = byDependency.get(site.dependency) ?? new Map<string, Requirement>()
        byDependency.set(site.dependency, requirements)
        const requirement = requirements.get(site.subpath) ?? { subpath: site.subpath, names: new Set(), files: new Set() }
        requirements.set(site.subpath, requirement)
        for (const name of site.names) requirement.names.add(name)
        requirement.files.add(site.file)
      }
    }

    for (const [dependencyName, bySubpath] of byDependency) {
      const dependency = byName.get(dependencyName)!
      const requirements = [...bySubpath.values()]
      const importedBy = [...new Set(requirements.flatMap((requirement) => [...requirement.files]))].join(', ')
      const groups = DEPENDENCY_GROUPS.filter((group) => manifest[group]?.[dependencyName] !== undefined)

      if (groups.length === 0) {
        plan.drift.push(
          `${manifestPath}: ${importedBy} import${importedBy.includes(',') ? '' : 's'} ${dependencyName} subpaths at ` +
            `runtime, but ${pkg.name} declares no ${dependencyName} in ${DEPENDENCY_GROUPS.join(' or ')}.`,
        )
        continue
      }

      for (const group of groups) {
        plan.edgesChecked += 1
        const range = manifest[group]![dependencyName]!
        const label = `${group}["${dependencyName}"]`
        if (!RANGE.test(range.trim())) {
          throw new CannotJudge(
            `${manifestPath}: ${label} is "${range}", a range shape this script cannot take a floor from. ` +
              'Use >=x.y.z, ^x.y.z, ~x.y.z or an exact version, or extend this script.',
          )
        }

        const admitted = admittedSnapshots(repo, dependency, range)
        const highestLacking = admitted
          .toReversed()
          .map((snapshot) => ({ snapshot, gaps: lacking(reader, dependency, snapshot, requirements) }))
          .find((entry) => entry.gaps.length > 0)
        if (!highestLacking) continue

        const lackingAt = highestLacking.snapshot
        const lackingFiles = requirements
          .filter((requirement) => lacking(reader, dependency, lackingAt, [requirement]).length > 0)
          .flatMap((requirement) => [...requirement.files])
        const why =
          `${label} is "${range}", which admits ${dependencyName} ${lackingAt.version}: ` +
          `${highestLacking.gaps.join('; ')} (imported by ${[...new Set(lackingFiles)].sort().join(', ')}).`

        const releases = repo.releases(dependency.relativeDir)
        const candidates = releases.filter((release) => Bun.semver.order(release.version, lackingAt.version) > 0)
        const workingTreeRecorded = releases.some((release) => release.version === dependency.version)
        if (!workingTreeRecorded && dependency.version) candidates.push({ version: dependency.version, rev: null })

        const carrying = candidates.find((candidate) => lacking(reader, dependency, candidate, requirements).length === 0)
        if (carrying) {
          const to = raisedRange(range, carrying.version, dependency.version)
          if (!to) {
            plan.drift.push(
              `${manifestPath}: ${why} The first release carrying all of it is ${carrying.version}, which "${range}" ` +
                'cannot be raised to without leaving its major, or excluding the workspace copy. Decide the range by hand.',
            )
            continue
          }
          plan.raises.push({ manifestPath, group, dependency: dependencyName, from: range, to, reason: why })
          continue
        }

        if (workingTreeRecorded && lacking(reader, dependency, { version: dependency.version!, rev: null }, requirements).length === 0) {
          plan.pending.push({ manifestPath, group, dependency: dependencyName, range, reason: why })
          continue
        }

        plan.drift.push(`${manifestPath}: ${why} Not even the working tree's ${dependencyName} exports all of it.`)
      }
    }
  }

  return plan
}

export interface RunResult {
  /** 0 clean, 1 drift, 2 the gate could not run. */
  code: 0 | 1 | 2
  messages: string[]
}

/** `release`: refuse a raise in a package whose version `changeset version` did not move. */
export async function run(options: { root?: string; check: boolean; release?: boolean }): Promise<RunResult> {
  const root = options.root ?? repoRoot
  let plan: FloorPlan
  let releasing: Map<string, string>
  try {
    plan = await planImportFloors(root)
    const workspace = await collectPackages(root)
    const versions = new Map(workspace.flatMap((pkg) => (pkg.version ? [[pkg.name, pkg.version] as const] : [])))
    // A plan that cannot be read must not read as "releases nothing": every pending import would fail as unshippable.
    const changesets = await readChangesetDirectory(join(root, '.changeset')).catch((cause: unknown) => {
      throw new CannotJudge(cause instanceof Error ? cause.message : String(cause))
    })
    releasing = plannedVersions(versions, changesets)
  } catch (error) {
    if (!(error instanceof CannotJudge)) throw error
    return { code: 2, messages: ['import floor audit could not run.', error.message] }
  }

  const messages: string[] = []
  const drift = [...plan.drift]

  for (const pending of plan.pending) {
    const next = releasing.get(pending.dependency)
    if (next) {
      messages.push(
        `${pending.manifestPath}: ${pending.reason} No release carries it yet; the pending changesets release ` +
          `${pending.dependency} as ${next}, and \`version-packages\` raises the floor then.`,
      )
    } else {
      drift.push(
        `${pending.manifestPath}: ${pending.reason} No release of ${pending.dependency} carries it and no pending ` +
          `changeset releases ${pending.dependency}, so no published copy ever will. Add a changeset for it.`,
      )
    }
  }

  if (options.check) {
    for (const raise of plan.raises) {
      drift.push(`${raise.manifestPath}: ${raise.reason} Raise it to "${raise.to}", the first release carrying all of it.`)
    }
  } else {
    const byManifest = Map.groupBy(plan.raises, (raise) => raise.manifestPath)
    for (const [manifestPath, raises] of byManifest) {
      const path = join(root, manifestPath)
      const text = await readFile(path, 'utf8')
      const manifest = JSON.parse(text) as Record<string, Record<string, string>>
      for (const raise of raises) {
        manifest[raise.group]![raise.dependency] = raise.to
        messages.push(`${manifestPath}: ${raise.group}["${raise.dependency}"] ${raise.from} -> ${raise.to}`)
      }
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

      // `changeset version` never bumps a package for an in-range peer, and `changeset publish`
      // skips a version that did not move. An unreadable version is not one that moved.
      const committed = versionOf(manifestAtRev('HEAD', manifestPath, root))
      const current = versionOf(text)
      if (options.release && (committed === undefined || current === undefined || committed === current)) {
        drift.push(
          `${manifestPath}: raised a floor, but its version is still ${current ?? 'unreadable'} (HEAD: ` +
            `${committed ?? 'unreadable'}), so no published tarball carries the raise. Add a changeset ` +
            'releasing this package, re-run `changeset version`, then this script.',
        )
      }
    }
  }

  if (drift.length > 0) return { code: 1, messages: [...drift, ...messages] }
  messages.push(`Import floors hold across ${plan.edgesChecked} dependency range(s).`)
  return { code: 0, messages }
}

if (import.meta.main) {
  const { flags } = parseArgs(process.argv.slice(2), ['check', 'release'])
  const result = await run({ check: flags.check!, release: flags.release! })
  const log = result.code === 0 ? console.log : console.error
  for (const message of result.messages) log(message)
  process.exit(result.code)
}
