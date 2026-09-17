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
import type * as t from '@babel/types'
import { walk, type BabelNode } from '../packages/cli/src/ast-walk'
import { parseSourceFile } from '../packages/cli/src/parse-cache'
import { readChangesetDirectory } from './smoke/core-semver-audit'
import { DEPENDENCY_GROUPS, plannedVersions } from './smoke/plugin-compat-audit'
import {
  collectPackages,
  manifestAtRev,
  parseArgs,
  repoRoot,
  versionOf,
  type WorkspacePackage,
} from './workspace-packages'

type DependencyGroup = (typeof DEPENDENCY_GROUPS)[number]

// Resolving a barrel at every admitted release is hundreds of files per version,
// and `@guren/core`'s root re-exports all of `@guren/server`'s. Subpath entries
// are a few files each, and are where cross-package internals are shared.
export const ROOT_ENTRY = '.'

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '/index.ts', '/index.tsx', '/index.js']
const TEST_FILE = /(\.test|\.spec)\.[cm]?[jt]sx?$|\/(__tests__|tests?|fixtures)\//

// Not `Bun.semver.satisfies(v, '*')`, which rejects every prerelease and would
// leave a committed `-next.0` unrecorded, standing in for releases it never was.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const RANGE = /^(>=|\^|~)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

export class CannotJudge extends Error {}

/** A package as it was published at `version`; `rev: null` reads the working tree. */
export interface Snapshot {
  version: string
  rev: string | null
}

interface Manifest {
  exports?: unknown
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** What one subpath of a snapshot exports. `open`: a star from outside the workspace. */
export interface Surface {
  exists: boolean
  names: Set<string>
  open: boolean
}

export interface ImportSite {
  dependency: string
  subpath: string
  /** Value names bound from the entry; empty when only the subpath must resolve. */
  names: string[]
}

export interface Requirement {
  subpath: string
  names: Set<string>
  files: Set<string>
}

export interface Gap {
  requirement: Requirement
  text: string
}

interface Raise {
  manifestPath: string
  group: DependencyGroup
  dependency: string
  from: string
  to: string
  reason: string
}

interface Pending {
  manifestPath: string
  dependency: string
  reason: string
}

interface FloorPlan {
  raises: Raise[]
  pending: Pending[]
  drift: string[]
  edgesChecked: number
}

export class Repository {
  private readonly texts = new Map<string, string | undefined>()
  private readonly histories = new Map<string, Snapshot[]>()

  constructor(readonly root: string) {}

  read(rev: string | null, path: string): string | undefined {
    const key = `${rev ?? ''}:${path}`
    if (!this.texts.has(key)) {
      this.texts.set(key, rev === null ? this.readWorkingTree(path) : manifestAtRev(rev, path, this.root))
    }
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

  /** Fills the read cache for many `rev:path` blobs with one process instead of one each. */
  private readBatch(requests: Array<{ rev: string; path: string }>): void {
    const batch = Bun.spawnSync(['git', 'cat-file', '--batch'], {
      cwd: this.root,
      stdin: Buffer.from(requests.map(({ rev, path }) => `${rev}:${path}\n`).join('')),
    })
    if (!batch.success) throw new CannotJudge(`git cat-file --batch failed: ${batch.stderr.toString().trim()}`)

    const out = batch.stdout
    let offset = 0
    for (const { rev, path } of requests) {
      const newline = out.indexOf(0x0a, offset)
      // `<oid> <type> <size>`, then that many bytes and a newline; `<input> missing` otherwise.
      const header = /^[0-9a-f]+ (\S+) (\d+)$/.exec(out.subarray(offset, newline).toString())
      offset = newline + 1
      if (!header) {
        this.texts.set(`${rev}:${path}`, undefined)
        continue
      }
      const end = offset + Number(header[2])
      this.texts.set(`${rev}:${path}`, header[1] === 'blob' ? out.subarray(offset, end).toString() : undefined)
      offset = end + 1
    }
  }

  /**
   * Every version the package's manifest declared, ascending, each read at the
   * first commit declaring it: the version commit is what publishing tags, so an
   * export added after it is attributed to the next version (a higher floor).
   */
  releases(relativeDir: string): Snapshot[] {
    const cached = this.histories.get(relativeDir)
    if (cached) return cached

    const path = `${relativeDir}/package.json`
    const log = Bun.spawnSync(['git', 'log', '--topo-order', '--reverse', '--format=%H', '--', path], { cwd: this.root })
    if (!log.success) throw new CannotJudge(`git log failed for ${path}: ${log.stderr.toString().trim()}`)
    const revs = log.stdout.toString().split('\n').filter(Boolean)
    this.readBatch(revs.map((rev) => ({ rev, path })))

    const releases: Snapshot[] = []
    for (const rev of revs) {
      const version = versionOf(this.read(rev, path))
      if (version === undefined || !VERSION.test(version) || releases.some((release) => release.version === version)) continue
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

/** Every recorded release, ascending, then the working tree when no commit declared its version yet. */
function snapshots(repo: Repository, pkg: WorkspacePackage): Snapshot[] {
  const releases = repo.releases(pkg.relativeDir)
  const version = pkg.version
  return version && !releases.some((release) => release.version === version)
    ? [...releases, { version, rev: null }]
    : releases
}

function parseModule(code: string, file: string): t.File {
  const ast = parseSourceFile(code, file)
  if (!ast) throw new CannotJudge(`Could not parse ${file} under any dialect parseSourceFile tries.`)
  return ast
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

export class SurfaceReader {
  private readonly surfaces = new Map<string, Surface>()
  private readonly modules = new Map<string, Surface>()

  /**
   * `reexports`: which copy of another workspace package a star re-export reads.
   * `lowest-admitted` judges a published release; `working-tree` judges the one about to ship.
   */
  constructor(
    private readonly repo: Repository,
    private readonly packages: ReadonlyMap<string, WorkspacePackage>,
    private readonly reexports: 'lowest-admitted' | 'working-tree' = 'lowest-admitted',
  ) {}

  manifest(pkg: WorkspacePackage, snapshot: Snapshot): Manifest {
    const path = `${pkg.relativeDir}/package.json`
    try {
      return JSON.parse(this.repo.read(snapshot.rev, path) ?? '') as Manifest
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
    const target = exportTarget(this.manifest(pkg, snapshot).exports, subpath)
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
    return this.moduleExports(pkg, snapshot, source, new Set())
  }

  private resolveFile(rev: string | null, base: string): string | undefined {
    return SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`).find((path) => this.repo.read(rev, path) !== undefined)
  }

  private moduleExports(pkg: WorkspacePackage, snapshot: Snapshot, file: string, visiting: Set<string>): Surface {
    const key = `${snapshot.rev ?? ''}:${file}`
    const cached = this.modules.get(key)
    if (cached) return cached
    if (visiting.has(file)) return { exists: true, names: new Set(), open: false }
    visiting.add(file)

    const names = new Set<string>()
    let open = false
    const program = parseModule(this.repo.read(snapshot.rev, file)!, file).program

    for (const statement of program.body) {
      if (statement.type === 'ExportAllDeclaration') {
        if (statement.exportKind === 'type') continue
        const reexported = this.starSurface(pkg, snapshot, file, statement.source.value, visiting)
        open ||= reexported.open
        for (const name of reexported.names) if (name !== 'default') names.add(name)
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
    file: string,
    specifier: string,
    visiting: Set<string>,
  ): Surface {
    if (specifier.startsWith('.')) {
      const target = this.resolveFile(snapshot.rev, withoutScriptExtension(posix.join(posix.dirname(file), specifier)))
      if (!target) throw new CannotJudge(`${file} re-exports ${specifier}, which resolves to no file at ${snapshot.rev ?? 'the working tree'}.`)
      return this.moduleExports(pkg, snapshot, target, visiting)
    }

    const split = splitSpecifier(specifier)
    const dependency = split && this.packages.get(split[0])
    if (!split || !dependency) return { exists: true, names: new Set(), open: true }
    if (this.reexports === 'working-tree') {
      return this.surface(dependency, { version: dependency.version ?? '', rev: null }, split[1])
    }

    // What this release re-exports depends on which copy the consumer installed;
    // the lowest its own range admits is the one that can lack a name.
    const manifest = this.manifest(pkg, snapshot)
    const range = manifest.dependencies?.[split[0]] ?? manifest.peerDependencies?.[split[0]]
    const lowest = range ? snapshots(this.repo, dependency).find((candidate) => Bun.semver.satisfies(candidate.version, range)) : undefined
    if (!lowest) {
      throw new CannotJudge(
        `${file} (${pkg.name} ${snapshot.version}) re-exports ${specifier}, but no release of ${split[0]} ` +
          `satisfies its declared range ${JSON.stringify(range)}.`,
      )
    }
    return this.surface(dependency, lowest, split[1])
  }
}

export function importSites(source: string, relativeFile: string): ImportSite[] {
  if (!source.includes('@guren/')) return []
  const program = parseModule(source, relativeFile).program
  const sites: ImportSite[] = []

  const add = (specifier: string, names: string[]): void => {
    const split = splitSpecifier(specifier)
    if (split) sites.push({ dependency: split[0], subpath: split[1], names })
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

  if (source.includes('import(')) {
    walk(program, (node) => {
      if (node.type !== 'CallExpression' || (node.callee as BabelNode).type !== 'Import') return
      const argument = (node.arguments as BabelNode[])[0]
      if (argument?.type === 'StringLiteral') add(argument.value as string, [])
    })
  }

  return sites
}

async function sourceFiles(pkg: WorkspacePackage): Promise<string[]> {
  const files: string[] = []
  for await (const path of new Bun.Glob('src/**/*.{ts,tsx,mts,js,mjs}').scan({ cwd: pkg.dir })) {
    if (!TEST_FILE.test(`/${path}`) && !path.endsWith('.d.ts')) files.push(path)
  }
  return files.sort()
}

/** What `snapshot` lacks of `requirements`; empty when it carries all. */
function lacking(reader: SurfaceReader, pkg: WorkspacePackage, snapshot: Snapshot, requirements: Requirement[]): Gap[] {
  return missingFrom((subpath) => reader.surface(pkg, snapshot, subpath), `${pkg.name} ${snapshot.version}`, requirements)
}

/** What the entries `surfaceAt` reads lack of `requirements`; `label` names that copy. */
export function missingFrom(surfaceAt: (subpath: string) => Surface, label: string, requirements: Requirement[]): Gap[] {
  const gaps: Gap[] = []
  for (const requirement of requirements) {
    const surface = surfaceAt(requirement.subpath)
    if (!surface.exists) {
      gaps.push({ requirement, text: `no ${requirement.subpath} subpath` })
      continue
    }
    const missing = [...requirement.names].filter((name) => !surface.names.has(name))
    if (missing.length === 0) continue
    if (surface.open) {
      throw new CannotJudge(
        `${label} ${requirement.subpath} re-exports a module outside this workspace, so ` +
          `whether it provides ${missing.join(', ')} cannot be read from source.`,
      )
    }
    gaps.push({ requirement, text: `${requirement.subpath} without ${missing.join(', ')}` })
  }
  return gaps
}

function raisedRange(operator: string, floor: string, to: string, workspaceVersion: string | undefined): string | null {
  const next = `${operator}${to}`
  const [floorMajor, floorMinor] = floor.split('.')
  const [toMajor, toMinor] = to.split('.')
  if (operator === '^' && floorMajor !== toMajor) return null
  if (operator === '~' && (floorMajor !== toMajor || floorMinor !== toMinor)) return null
  if (operator === '' || (workspaceVersion && !Bun.semver.satisfies(workspaceVersion, next))) return null
  return next
}

async function planImportFloors(root: string, workspace: WorkspacePackage[]): Promise<FloorPlan> {
  const repo = new Repository(root)
  repo.assertFullHistory()

  const byName = new Map(workspace.map((pkg) => [pkg.name, pkg]))
  const reader = new SurfaceReader(repo, byName)
  const plan: FloorPlan = { raises: [], pending: [], drift: [], edgesChecked: 0 }

  for (const pkg of workspace) {
    if (pkg.private) continue
    const manifestPath = `${pkg.relativeDir}/package.json`
    const manifest = reader.manifest(pkg, { version: pkg.version ?? '', rev: null })

    const byDependency = new Map<string, Map<string, Requirement>>()
    for (const file of await sourceFiles(pkg)) {
      const relativeFile = `${pkg.relativeDir}/${file}`
      for (const site of importSites(readFileSync(join(pkg.dir, file), 'utf8'), relativeFile)) {
        if (site.dependency === pkg.name || site.subpath === ROOT_ENTRY || !byName.has(site.dependency)) continue
        const requirements = byDependency.get(site.dependency) ?? new Map<string, Requirement>()
        byDependency.set(site.dependency, requirements)
        const requirement = requirements.get(site.subpath) ?? { subpath: site.subpath, names: new Set(), files: new Set() }
        requirements.set(site.subpath, requirement)
        for (const name of site.names) requirement.names.add(name)
        requirement.files.add(relativeFile)
      }
    }

    for (const [dependencyName, bySubpath] of byDependency) {
      const dependency = byName.get(dependencyName)!
      const requirements = [...bySubpath.values()]
      const groups = DEPENDENCY_GROUPS.filter((group) => manifest[group]?.[dependencyName] !== undefined)

      if (groups.length === 0) {
        const importedBy = [...new Set(requirements.flatMap((requirement) => [...requirement.files]))].join(', ')
        plan.drift.push(
          `${manifestPath}: ${importedBy} import${importedBy.includes(',') ? '' : 's'} ${dependencyName} subpaths at ` +
            `runtime, but ${pkg.name} declares no ${dependencyName} in ${DEPENDENCY_GROUPS.join(' or ')}.`,
        )
        continue
      }

      const history = snapshots(repo, dependency)
      const workingTreeRecorded = history.at(-1)?.rev !== null

      for (const group of groups) {
        plan.edgesChecked += 1
        const range = manifest[group]![dependencyName]!
        const label = `${group}["${dependencyName}"]`
        const shape = RANGE.exec(range.trim())
        if (!shape) {
          throw new CannotJudge(
            `${manifestPath}: ${label} is "${range}", a range shape this script cannot take a floor from. ` +
              'Use >=x.y.z, ^x.y.z, ~x.y.z or an exact version, or extend this script.',
          )
        }

        const admitted = history.filter((snapshot) => Bun.semver.satisfies(snapshot.version, range))
        let lackingAt: Snapshot | undefined
        let gaps: Gap[] = []
        for (const snapshot of admitted.toReversed()) {
          gaps = lacking(reader, dependency, snapshot, requirements)
          if (gaps.length > 0) {
            lackingAt = snapshot
            break
          }
        }
        if (!lackingAt) continue

        const lackingFiles = [...new Set(gaps.flatMap((gap) => [...gap.requirement.files]))].sort()
        const why =
          `${label} is "${range}", which admits ${dependencyName} ${lackingAt.version}: ` +
          `${gaps.map((gap) => gap.text).join('; ')} (imported by ${lackingFiles.join(', ')}).`

        const floorVersion = lackingAt.version
        const carrying = history
          .filter((snapshot) => Bun.semver.order(snapshot.version, floorVersion) > 0)
          .find((candidate) => lacking(reader, dependency, candidate, requirements).length === 0)
        if (carrying) {
          const to = raisedRange(shape[1] ?? '', shape[2]!, carrying.version, dependency.version)
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
          plan.pending.push({ manifestPath, dependency: dependencyName, reason: why })
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
    const workspace = await collectPackages(root)
    plan = await planImportFloors(root, workspace)
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
