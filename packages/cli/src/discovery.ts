import { readdir, access, lstat, readFile, stat } from 'node:fs/promises'
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
 * Recursively collect files matching `extensions`, skipping dotfiles,
 * declaration files, and any directory named in `excludeDirNames`.
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
 * platform — globs and git-diff entries are always POSIX-style.
 */
export function toPosixRelative(cwd: string, absPath: string): string {
  return relative(cwd, absPath).split(sep).join('/')
}

/**
 * Module name if `relPath` — POSIX-relative, as `toPosixRelative` produces —
 * is under `modules/<name>/`, else `null`. The one source of truth for
 * "module path → name", shared by the arch and consistency checks.
 */
export function moduleNameFromRelPath(relPath: string): string | null {
  const match = /^modules\/([^/]+)\//.exec(relPath)
  return match ? match[1] : null
}

/**
 * `moduleNameFromRelPath` for an absolute path, so a check that assumes a
 * single project-root file can resolve the module-scoped equivalent instead.
 */
export function moduleNameFor(cwd: string, filePath: string): string | null {
  return moduleNameFromRelPath(toPosixRelative(cwd, filePath))
}

/**
 * Whether the path is *definitely* not there — for a loader that degrades a
 * missing file to an empty result. {@link fileExists} answers "can I read this",
 * which reads a broken configuration (`EACCES`, `ENOTDIR`, a dangling symlink) as
 * "you have none". Non-ENOENT outcomes answer `false` here, so the caller attempts
 * the load and its own error is reported. `lstat`, not `access`: a dangling symlink goes to the loader too.
 */
export async function isDefinitelyAbsent(cwd: string, relativePath: string): Promise<boolean> {
  try {
    await lstat(resolve(cwd, relativePath))
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/**
 * Whether the path can be read: follows symlinks, throws on anything but
 * ENOENT. A loader that must not crash on a broken filesystem wants
 * {@link isDefinitelyAbsent} instead.
 */
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
 * exists under `cwd`, or `null`. One probe for every caller that has to *find*
 * a conventional file: two copies could disagree about preference order, which
 * decides which file the whole command then reads.
 */
export async function findFirstExisting(cwd: string, candidates: readonly string[]): Promise<string | null> {
  const results = await Promise.all(candidates.map((candidate) => fileExists(cwd, candidate)))
  const index = results.indexOf(true)
  return index === -1 ? null : candidates[index]
}

/**
 * {@link findFirstExisting} for a *loader*: the first candidate that is not
 * {@link isDefinitelyAbsent}, so a broken-but-present config reaches the
 * import and is diagnosed rather than skipped.
 */
export async function findFirstLoadable(cwd: string, candidates: readonly string[]): Promise<string | null> {
  const results = await Promise.all(candidates.map((candidate) => isDefinitelyAbsent(cwd, candidate)))
  const index = results.indexOf(false)
  return index === -1 ? null : candidates[index]
}

export type JsonReadResult<T> =
  | { exists: false; raw: null; value: null; parseError: null }
  | { exists: true; raw: string; value: T; parseError: null }
  | { exists: true; raw: string; value: null; parseError: Error }

/**
 * A JSON file's three states — absent, parsed, present-but-unparseable — kept
 * apart so a caller can tell "you have none" from "yours is broken". `raw` is
 * returned beside `value` for patchers that edit the text in place.
 */
export async function readJsonIfExists<T>(cwd: string, relativePath: string): Promise<JsonReadResult<T>> {
  const raw = await readIfExists(cwd, relativePath)
  if (raw === null) {
    return { exists: false, raw: null, value: null, parseError: null }
  }

  try {
    return { exists: true, raw, value: JSON.parse(raw) as T, parseError: null }
  } catch (error) {
    return { exists: true, raw, value: null, parseError: error as Error }
  }
}

export async function readIfExists(cwd: string, relativePath: string): Promise<string | null> {
  if (!(await fileExists(cwd, relativePath))) {
    return null
  }

  return readFile(resolve(cwd, relativePath), 'utf8')
}

/**
 * Whether the app's `package.json` declares `packageName`, as a dependency or a
 * devDependency — `null` when the manifest cannot be read or parsed. Three-valued
 * on purpose: "does not depend on this" and "no manifest to ask" are different
 * answers, and callers pick their own default for `null`. Every failure mode collapses
 * to `null`, including the ones `readIfExists` rethrows, so an `EACCES` cannot propagate.
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
 * Directory names directly under `modules/` (RFC 0002). An absent `modules/`
 * resolves to an empty list, not an error.
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
 * The app root plus every `modules/<name>/` directory, tagged with its module
 * name — the one "root + modules" fan-out point, shared by the `discover*Files`
 * functions below, `scanDocs`, and the entity context's db-artifact scans.
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
 * what makes every `discover*Files` function below module-aware for free.
 * Test files are excluded: a co-located `<Name>.test.ts` sibling is a test,
 * not a component. `roots` overrides the fan-out for a caller that has already
 * narrowed it to one app root.
 */
async function discoverDir(appRoot: string, subDir: string, roots?: AppRoot[]): Promise<string[]> {
  const scanned = roots ?? (await listAppRoots(appRoot))
  const groups = await Promise.all(scanned.map((root) => collectFiles(resolve(root.dir, subDir))))
  return groups.flat().filter((file) => !TEST_FILE_PATTERN.test(file))
}

/**
 * Every file under `directory`, skipping only dependency/build directories and
 * `.git`. Unlike `collectFiles`, dotfiles and all extensions are included —
 * docs `related:` globs may target markdown, workflows, or migrations.
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

/**
 * Where an app's models live, relative to an app root. Same contract as
 * {@link RESOURCES_DIR}: `make:model` writes here, `discoverModelFiles` reads
 * here, and the Vite plugin watches it to regenerate `attachments.gen.ts`.
 */
export const MODELS_DIR = 'app/Models'

export function discoverModelFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, MODELS_DIR)
}

/**
 * Every source file under `app/`, module roots included — for checks whose
 * subject can live anywhere rather than in one conventional directory.
 */
export function discoverAppSourceFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app')
}

export function discoverControllerFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Http/Controllers')
}

/**
 * Where an app's `JsonResource` subclasses live, relative to an app root:
 * `make:resource` writes here, `discoverResourceFiles` reads here, the data
 * generator stamps it into `data.gen.ts`, and the Vite plugin watches it. Same
 * reason as {@link DB_ARTIFACT_DIRS}: a reader holding its own copy of the path
 * can only ever conclude "not where I happened to look".
 */
export const RESOURCES_DIR = 'app/Http/Resources'

/**
 * Resource classes at the project root and in every module. `subDir` relocates
 * the scan for `generateDataTypes`'s `resourcesDir` option; a parameter rather
 * than a second scan in the caller, so an override still inherits the module
 * fan-out and the test-file exclusion.
 */
export function discoverResourceFiles(appRoot: string, subDir: string = RESOURCES_DIR): Promise<string[]> {
  return discoverDir(appRoot, subDir)
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
 * Route files under `<appRoot>/routes/`, tests excluded. Scoped to the given root
 * on purpose, unlike the `discover*Files` siblings that fan out over
 * `listAppRoots()`: a module mounts its routes through `defineModule({ routes })`
 * rather than the project's entry registrar, so the two are not the same question.
 * See {@link discoverModuleRoutesFiles}.
 */
export function discoverRoutesFiles(appRoot: string): Promise<string[]> {
  return collectFiles(resolve(appRoot, 'routes'), IMPORTABLE_EXTENSIONS).then((files) =>
    files.filter((file) => !TEST_FILE_PATTERN.test(file)),
  )
}

/** One module's `routes/` directory, for the wiring question scoped to it. */
export interface ModuleRoutes {
  module: string
  /** Absolute path of `modules/<name>/`. */
  dir: string
  /** Route files under `modules/<name>/routes/`, tests excluded. */
  files: string[]
}

/**
 * Route files under each module's own `routes/` directory, grouped by module.
 * Modules with no such directory are dropped rather than reported empty:
 * `make:module` scaffolds a single `modules/<name>/routes.ts`, so an app that
 * never ran `make:route --module` has nothing here to ask about.
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
 * Files a module may keep its routes registrar in, in probe order. The
 * counterpart to {@link discoverModuleRoutesFiles}, which asks only about a
 * module's `routes/` *directory* and so returns nothing for the scaffolded
 * shape. One list, because a second copy is how one check comes to read
 * `modules/x/routes.mts` while the other does not.
 */
export function moduleRoutesEntryCandidates(moduleDir: string): string[] {
  return [`${moduleDir}/routes.ts`, `${moduleDir}/routes.js`, `${moduleDir}/routes/index.ts`, `${moduleDir}/routes/index.js`]
}

/**
 * Files under the console-command directories. Nothing loads these by scanning
 * at runtime — `ConsoleKernel` registration is explicit — so this is for
 * tooling only, and it is content-blind: both consumers go through
 * `discoverDeclaredCommandFiles` in `console-check.ts`, which filters this walk
 * to files that actually declare a command.
 */
export function discoverCommandFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Console/Commands')
}

/**
 * Test files anywhere in the project: under `tests/` (what scaffolded apps
 * use) as well as colocated beside source files.
 */
export async function discoverTestFiles(appRoot: string): Promise<string[]> {
  const files = await collectFiles(appRoot, TEST_FILE_EXTENSIONS, NON_SOURCE_DIR_NAMES)
  return files.filter((file) => TEST_FILE_PATTERN.test(file))
}

/**
 * Paths — POSIX-relative to `cwd` — that would satisfy "this controller has a
 * test", in probe order. A controller inside `modules/<name>/` is only ever paired
 * with a test in the same module, since the boundary check forbids the project-root
 * `tests/` from importing module internals. Detection is by filename only: a match
 * says a file is named after the controller, not that it exercises it — see {@link describeControllerTestMiss}.
 */
export function controllerTestCandidates(cwd: string, controllerPath: string): string[] {
  const name = classNameFromPath(controllerPath)
  const relPath = toPosixRelative(cwd, controllerPath)
  const dir = posix.dirname(relPath)
  const siblingDir = dir === '.' ? '' : `${dir}/`
  const moduleName = moduleNameFromRelPath(relPath)
  const prefix = moduleName ? `modules/${moduleName}/` : ''

  // A `.js`/`.mts` controller may be tested by a same-extension sibling, but
  // `.test.ts` stays a candidate there too; `make:test` only ever emits that.
  const siblingExtensions = Array.from(new Set([extname(controllerPath), '.ts']))

  return [
    ...siblingExtensions.map((ext) => `${siblingDir}${name}.test${ext}`),
    `${prefix}tests/controllers/${name}.test.ts`,
    `${prefix}tests/${name}.test.ts`,
  ]
}

/**
 * How a miss must be phrased — one string, because `guren check` and
 * `guren doctor --next` both report it.
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
 * append. Both scaffolders import this rather than declaring the path
 * themselves, which is what lets a reader treat a miss as "no such artifact
 * exists" rather than "not where this constant knows to look".
 */
export const DB_ARTIFACT_DIRS = {
  Factory: 'db/factories',
  Seeder: 'db/seeders',
} as const

export type DbArtifactKind = keyof typeof DB_ARTIFACT_DIRS

/**
 * Matches the factory or seeder file names that belong to an entity. Tolerance,
 * not derivation: `make:factory`/`make:seeder` append their suffix to whatever the
 * user typed without inflecting it, so the singular, the inflected plural, and the
 * naive `+s` plural are all accepted, and `(?:^|_)` lets a numbered seeder
 * (`002_PostsSeeder`) match. Over-tolerance costs a stray listing; under-tolerance silently misses. Contrast `inflect.ts`.
 */
export function dbArtifactPattern(entity: string, kind: DbArtifactKind): RegExp {
  const forms = [...new Set([entity, `${entity}s`, collectionName(entity)])]
  return new RegExp(`(?:^|_)(?:${forms.map(escapeRegExp).join('|')})${kind}\\.`, 'i')
}

/**
 * Every factory (or seeder) file in the project — the listing half of "which
 * artifacts belong to this entity?", with {@link dbArtifactPattern} as the
 * matching half. Shared so `guren context <Entity>` and `guren doctor --next`
 * cannot disagree about whether an entity already has one. `roots` narrows the
 * fan-out for a caller that has already picked one.
 */
export function discoverDbArtifactFiles(
  appRoot: string,
  kind: DbArtifactKind,
  roots?: AppRoot[],
): Promise<string[]> {
  return discoverDir(appRoot, DB_ARTIFACT_DIRS[kind], roots)
}

/**
 * The ` --module <name>` suffix a suggested `make:*` command needs to scaffold
 * beside `filePath`, empty for a root-level file. One home for the leading
 * space, which is load-bearing and invisible at every call site.
 */
export function moduleFlagFor(cwd: string, filePath: string): string {
  const moduleName = moduleNameFor(cwd, filePath)
  return moduleName ? ` --module ${moduleName}` : ''
}

export function classNameFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.(ts|mts|js|mjs)$/, '')
}

export function excludeBarrelFiles(files: string[]): string[] {
  return files.filter((f) => {
    const base = f.split('/').pop() ?? ''
    return !base.startsWith('index.')
  })
}

/**
 * Renders the first `limit` items, then `and N more` — how a caveat names a
 * handful of examples out of a possibly-long list.
 */
export function formatTruncatedList(items: string[], limit = 3): string {
  const shown = items.slice(0, limit).join(', ')
  const more = items.length > limit ? ` and ${items.length - limit} more` : ''
  return `${shown}${more}`
}

/**
 * Whether the app already binds `key` in the container. The conventional
 * provider file name answers this in neither direction: a custom provider
 * binds the service without that file, and installing a second manager over it
 * would shadow the app's own.
 */
export async function appBindsService(key: string, appRoot: string): Promise<string[]> {
  const roots = await listAppRoots(appRoot)
  const groups = await Promise.all(
    roots.flatMap((root) => ['app', 'src'].map((dir) => collectFiles(resolve(root.dir, dir)))),
  )
  const bindingPattern = new RegExp(`\\b(?:instance|singleton|bind)\\(\\s*['"]${escapeRegExp(key)}['"]`)
  const binding: string[] = []
  for (const filePath of groups.flat()) {
    const source = await readIfExists(appRoot, filePath)
    if (source && bindingPattern.test(source)) binding.push(filePath)
  }
  return binding
}

/**
 * Where a `configureAttachments()` call can live: the documented home is
 * `config/attachments.ts`, but nothing enforces the filename, so every
 * config/, src/, and app/ source of the app and its modules is scanned (the
 * string pre-filter below keeps that cheap).
 */
export async function discoverAppConfigFiles(appRoot: string): Promise<string[]> {
  const roots = await listAppRoots(appRoot)
  const groups = await Promise.all(
    roots.flatMap((root) =>
      ['config', 'src', 'app'].map((dir) => collectFiles(resolve(root.dir, dir))),
    ),
  )
  return groups.flat().filter((file) => !/\.test\.[jt]sx?$/.test(file))
}

