import { readdir, access, readFile, stat } from 'node:fs/promises'
import { resolve, join, extname, relative, sep, posix } from 'node:path'
import { collectionName } from './inflect'
import { escapeRegExp } from './utils'

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs'])
const TEST_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'])
const TEST_FILE_PATTERN = /\.test\.(ts|tsx|mts|js|jsx|mjs)$/

// Directories that never contain a project's own source/test files — skipped
// when scanning from the project root (not needed for the scoped app/**
// discoverers below, which never descend into these anyway).
export const NON_SOURCE_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage'])

// Extensions worth parsing for import specifiers when scanning the whole
// project (arch boundary checks) rather than one known component directory.
export const IMPORTABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'])

/**
 * Recursively collect files from a directory matching given extensions.
 * Skips dotfiles, declaration files (.d.ts), and any directory named in
 * `excludeDirNames`.
 */
export async function collectFiles(
  directory: string,
  extensions: Set<string> = SOURCE_EXTENSIONS,
  excludeDirNames: Set<string> = new Set(),
): Promise<string[]> {
  const results: string[] = []

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue

    const fullPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      if (excludeDirNames.has(entry.name)) continue
      results.push(...(await collectFiles(fullPath, extensions, excludeDirNames)))
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.d.ts')) continue
      if (extensions.has(extname(entry.name))) {
        results.push(fullPath)
      }
    }
  }

  return results
}

/**
 * Path of `absPath` relative to `cwd`, with `/` separators regardless of
 * platform. Used wherever a path needs to be compared against a glob or a
 * git-diff entry, both of which are always POSIX-style.
 */
export function toPosixRelative(cwd: string, absPath: string): string {
  return relative(cwd, absPath).split(sep).join('/')
}

/**
 * Module name (e.g. `'billing'`) if `relPath` — a POSIX-relative path, as
 * produced by `toPosixRelative` — is under `modules/<name>/`, else `null`.
 * The single source of truth for "module path → name" shared by the arch
 * boundary checks and the consistency checks.
 */
export function moduleNameFromRelPath(relPath: string): string | null {
  const match = /^modules\/([^/]+)\//.exec(relPath)
  return match ? match[1] : null
}

/**
 * `moduleNameFromRelPath` for an absolute path: module name if `filePath`
 * is under `<cwd>/modules/<name>/`, else `null`. Lets checks that assume a
 * single project-root file (tests, schema, console entry) resolve the right
 * module-scoped equivalent instead of always looking at the top level.
 */
export function moduleNameFor(cwd: string, filePath: string): string | null {
  return moduleNameFromRelPath(toPosixRelative(cwd, filePath))
}

export async function fileExists(cwd: string, relativePath: string): Promise<boolean> {
  try {
    await access(resolve(cwd, relativePath))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/**
 * The first of `candidates` (project-relative, in preference order) that
 * exists under `cwd`, or `null`.
 *
 * One probe for every caller that has to *find* a conventional file rather
 * than assume one — `doctor` locating the app's routes entry, `guren check`
 * doing the same. Two copies could disagree about preference order, which
 * decides which file the whole command then reads.
 */
export async function findFirstExisting(cwd: string, candidates: readonly string[]): Promise<string | null> {
  const results = await Promise.all(candidates.map((candidate) => fileExists(cwd, candidate)))
  const index = results.indexOf(true)
  return index === -1 ? null : candidates[index]
}

export async function readIfExists(cwd: string, relativePath: string): Promise<string | null> {
  if (!(await fileExists(cwd, relativePath))) {
    return null
  }

  return readFile(resolve(cwd, relativePath), 'utf8')
}

/**
 * Whether the app's `package.json` declares `packageName`, as a dependency or
 * a devDependency — `null` when the manifest cannot be read or parsed.
 *
 * Three-valued on purpose. "The app does not depend on this" and "there is no
 * manifest to ask" are different answers, and which one is safe depends
 * entirely on what the caller does with it: skipping optional output on a
 * guess is harmless, refusing a command on the same guess is not. Callers pick
 * their own default for `null`; this must never pick one for them.
 *
 * Every failure mode collapses to `null`, including the ones `readIfExists`
 * rethrows. A caller that wanted "unknown" to be survivable would otherwise get
 * an `EACCES` propagated out of a question it was prepared to answer either way
 * — a raw filesystem error from `guren add admin`, or an aborted `guren
 * codegen` where the old hand-rolled probe simply skipped its optional output.
 */
export async function appDependsOn(cwd: string, packageName: string): Promise<boolean | null> {
  let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

  try {
    const manifest = await readIfExists(cwd, 'package.json')
    if (manifest === null) {
      return null
    }
    parsed = JSON.parse(manifest)
  } catch {
    return null
  }

  return Boolean(parsed.dependencies?.[packageName] ?? parsed.devDependencies?.[packageName])
}

export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath)
    return s.isDirectory()
  } catch {
    return false
  }
}

/**
 * Directory names directly under `modules/` (RFC 0002) — e.g. `['billing',
 * 'inventory']`. Missing/absent `modules/` (the common case for apps that
 * haven't adopted modules) resolves to an empty list, not an error.
 */
export async function listModuleNames(appRoot: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(resolve(appRoot, 'modules'), { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
}

/**
 * The app root plus every `modules/<name>/` directory, each tagged with
 * its module name — the single "root + modules" fan-out point shared by
 * the `discover*Files` functions below, `scanDocs`, and the entity
 * context's db-artifact scans.
 */
export interface AppRoot {
  module: string | null
  dir: string
}

export async function listAppRoots(appRoot: string): Promise<AppRoot[]> {
  const names = await listModuleNames(appRoot)
  return [
    { module: null, dir: appRoot },
    ...names.map((name) => ({ module: name, dir: resolve(appRoot, 'modules', name) })),
  ]
}

/**
 * Scans `<appRoot>/<subDir>` plus `<subDir>` under every module directory —
 * what makes every `discover*Files` function below (and everything built
 * on them: `check`, `audit`, `context`, `model:list`, `doctor`)
 * module-aware for free.
 *
 * Test files are excluded: components are frequently tested by a co-located
 * `<Name>.test.ts` sibling, and those files are tests, not components of the
 * kind each `discover*Files` function reports.
 *
 * `roots` overrides the fan-out for callers that have already narrowed it to
 * one app root.
 */
async function discoverDir(appRoot: string, subDir: string, roots?: AppRoot[]): Promise<string[]> {
  const scanned = roots ?? (await listAppRoots(appRoot))
  const groups = await Promise.all(scanned.map((root) => collectFiles(resolve(root.dir, subDir))))
  return groups.flat().filter((file) => !TEST_FILE_PATTERN.test(file))
}

/**
 * Recursively collect every file under `directory`, skipping only
 * dependency/build directories and `.git`. Unlike `collectFiles`, dotfiles
 * and all extensions are included — docs `related:` globs may target
 * markdown, JSON, workflows, or migrations, not just source files.
 */
export async function collectAllFiles(directory: string): Promise<string[]> {
  const results: string[] = []

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (NON_SOURCE_DIR_NAMES.has(entry.name) || entry.name === '.git') continue
      results.push(...(await collectAllFiles(fullPath)))
    } else if (entry.isFile()) {
      results.push(fullPath)
    }
  }

  return results
}

export function discoverModelFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Models')
}

export function discoverControllerFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Http/Controllers')
}

export function discoverResourceFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Http/Resources')
}

export function discoverEventFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Events')
}

export function discoverJobFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Jobs')
}

export function discoverMiddlewareFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Http/middleware')
}

export function discoverListenerFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Listeners')
}

export function discoverValidatorFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Http/Validators')
}

export function discoverPolicyFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Policies')
}

/**
 * Route files under `<appRoot>/routes/`, tests excluded.
 *
 * Scoped to the given root on purpose, unlike the `discover*Files` siblings
 * that fan out over `listAppRoots()`: a module mounts its routes through
 * `defineModule({ routes })` rather than through the project's entry
 * registrar, so the two are not the same question. Modules are covered by
 * {@link discoverModuleRoutesFiles}, which asks that other question — per
 * module, by calling this with the module directory as the root.
 */
export function discoverRoutesFiles(appRoot: string): Promise<string[]> {
  return collectFiles(resolve(appRoot, 'routes'), IMPORTABLE_EXTENSIONS).then((files) =>
    files.filter((file) => !TEST_FILE_PATTERN.test(file)),
  )
}

/** One module's `routes/` directory, for the wiring question scoped to it. */
export interface ModuleRoutes {
  /** Directory name under `modules/` — e.g. `'billing'`. */
  module: string
  /** Absolute path of `modules/<name>/`. */
  dir: string
  /** Route files under `modules/<name>/routes/`, tests excluded. */
  files: string[]
}

/**
 * Route files under each module's own `routes/` directory, grouped by module
 * — where `make:route --module <name>` writes, and the module half of the
 * registrar-wiring question.
 *
 * Modules with no such directory are dropped rather than reported empty: the
 * shape `make:module` scaffolds is a single `modules/<name>/routes.ts`, so an
 * app that never ran `make:route --module` has nothing here to ask about.
 */
export async function discoverModuleRoutesFiles(appRoot: string): Promise<ModuleRoutes[]> {
  const modules = (await listAppRoots(appRoot)).filter(
    (root): root is { module: string; dir: string } => root.module !== null,
  )

  const scanned = await Promise.all(
    modules.map(async ({ module, dir }) => ({ module, dir, files: await discoverRoutesFiles(dir) })),
  )

  return scanned.filter((entry) => entry.files.length > 0)
}

/**
 * Console command classes (`make:command` output). Unlike controllers or
 * jobs, nothing loads these by scanning the directory at runtime —
 * registration with a `ConsoleKernel` is explicit — so this discovery exists
 * for tooling only: `guren context` lists them, and `guren check` warns about
 * any that no console entrypoint references.
 */
export function discoverCommandFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Console/Commands')
}

/**
 * Discover `*.test.{ts,tsx,mts,js,jsx,mjs}` files anywhere in the project:
 * under `tests/` (the convention used by scaffolded apps and the blog
 * example) as well as colocated next to source files elsewhere (the
 * convention this framework's own packages use — see CLAUDE.md).
 */
export async function discoverTestFiles(appRoot: string): Promise<string[]> {
  const files = await collectFiles(appRoot, TEST_FILE_EXTENSIONS, NON_SOURCE_DIR_NAMES)
  return files.filter((file) => TEST_FILE_PATTERN.test(file))
}

/**
 * Paths — POSIX-relative to `cwd` — that would satisfy "this controller has
 * a test", in probe order: the co-located sibling first, then the `tests/`
 * layouts `make:test` scaffolds. A controller inside `modules/<name>/` is
 * only ever paired with a test inside the same module, since the module
 * boundary check forbids the project-root `tests/` from importing module
 * internals — hence the `modules/<name>/` prefix on the `tests/` candidates.
 *
 * Detection is by filename and nothing else: a match says a file is named after
 * the controller, not that it exercises it, and a miss says nothing about
 * coverage. Report a miss with {@link describeControllerTestMiss} so that bound
 * is stated wherever it surfaces.
 */
export function controllerTestCandidates(cwd: string, controllerPath: string): string[] {
  const name = classNameFromPath(controllerPath)
  const relPath = toPosixRelative(cwd, controllerPath)
  const dir = posix.dirname(relPath)
  const siblingDir = dir === '.' ? '' : `${dir}/`
  const moduleName = moduleNameFromRelPath(relPath)
  const prefix = moduleName ? `modules/${moduleName}/` : ''

  // A `.js`/`.mts` controller may be tested by a same-extension sibling, but
  // `.test.ts` stays a candidate there too. The `tests/` layouts below are
  // only ever scaffolded by `make:test`, which always emits `.test.ts`.
  const siblingExtensions = Array.from(new Set([extname(controllerPath), '.ts']))

  return [
    ...siblingExtensions.map((ext) => `${siblingDir}${name}.test${ext}`),
    `${prefix}tests/controllers/${name}.test.ts`,
    `${prefix}tests/${name}.test.ts`,
  ]
}

/**
 * How a miss must be phrased — one string, because `guren check` and
 * `guren doctor --next` both report it and a doc comment cannot keep two
 * wordings in step.
 */
export function describeControllerTestMiss(cwd: string, controllerPath: string): string {
  const name = classNameFromPath(controllerPath)
  const candidates = controllerTestCandidates(cwd, controllerPath).join(', ')
  return `No test file named after ${name} (filename-only detection; looked for ${candidates}).`
}

export async function hasControllerTest(cwd: string, controllerPath: string): Promise<boolean> {
  for (const candidate of controllerTestCandidates(cwd, controllerPath)) {
    if (await fileExists(cwd, candidate)) return true
  }
  return false
}

/**
 * Where `make:factory` and `make:seeder` write, keyed by the suffix they
 * append. Those two scaffolders import this rather than declaring the path
 * themselves, which is what makes it safe for the readers below — and for
 * `guren doctor --next`, which suggests running `make:factory` when a scan
 * finds nothing — to treat a miss here as "no such artifact exists" rather
 * than "it was written somewhere this constant does not know about".
 */
export const DB_ARTIFACT_DIRS = {
  Factory: 'db/factories',
  Seeder: 'db/seeders',
} as const

export type DbArtifactKind = keyof typeof DB_ARTIFACT_DIRS

/**
 * Matches the factory or seeder file names that belong to an entity.
 *
 * Tolerance, not derivation. `make:factory` and `make:seeder` append their
 * suffix to whatever the user typed without inflecting it, so the file name is
 * the user's choice and every plausible spelling of it has to be accepted: the
 * singular, the inflected plural (`Category` → `CategoriesFactory`), and the
 * naive `+s` plural a user may well have typed. `(?:^|_)` lets a numbered
 * seeder such as `002_PostsSeeder` match.
 *
 * The cost of over-tolerance is a stray file listed against an entity; the cost
 * of under-tolerance is an existing one silently missing. Prefer the former.
 * Contrast {@link controllerTestCandidates}, which probes exact paths, and
 * `inflect.ts`, which must produce exactly one name and so declines to guess.
 */
export function dbArtifactPattern(entity: string, kind: DbArtifactKind): RegExp {
  const forms = [...new Set([entity, `${entity}s`, collectionName(entity)])]
  return new RegExp(`(?:^|_)(?:${forms.map(escapeRegExp).join('|')})${kind}\\.`, 'i')
}

/**
 * Every factory (or seeder) file in the project, from the app root and each
 * module — the listing half of "which artifacts belong to this entity?",
 * with {@link dbArtifactPattern} as the matching half. Shared so that
 * `guren context <Entity>` and `guren doctor --next` cannot drift into
 * disagreeing about whether an entity already has one.
 *
 * `roots` narrows the fan-out for a caller that has already picked one.
 */
export function discoverDbArtifactFiles(
  appRoot: string,
  kind: DbArtifactKind,
  roots?: AppRoot[],
): Promise<string[]> {
  return discoverDir(appRoot, DB_ARTIFACT_DIRS[kind], roots)
}

/**
 * The ` --module <name>` suffix a suggested `make:*` command needs so that it
 * scaffolds beside `filePath` rather than at the project root — empty for a
 * root-level file. One home for the leading space, which is load-bearing at
 * every call site and invisible at all of them.
 */
export function moduleFlagFor(cwd: string, filePath: string): string {
  const moduleName = moduleNameFor(cwd, filePath)
  return moduleName ? ` --module ${moduleName}` : ''
}

/**
 * Extract a class name from a file path.
 * e.g., '/app/Models/Post.ts' → 'Post'
 */
export function classNameFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(ts|mts|js|mjs)$/, '')
}

/**
 * Filter out index/barrel files from discovered file lists.
 */
export function excludeBarrelFiles(files: string[]): string[] {
  return files.filter((f) => {
    const base = f.split('/').pop() ?? ''
    return !base.startsWith('index.')
  })
}

/**
 * Renders the first `limit` items, then `and N more` — the shape a
 * caveat/warning uses to name a handful of examples without listing an
 * unbounded list. Shared by `guren check`'s scan-coverage warning and the
 * deploy checks' unparsed-file caveat, which both name a possibly-long list of
 * files that failed to read or parse.
 */
export function formatTruncatedList(items: string[], limit = 3): string {
  const shown = items.slice(0, limit).join(', ')
  const more = items.length > limit ? ` and ${items.length - limit} more` : ''
  return `${shown}${more}`
}
