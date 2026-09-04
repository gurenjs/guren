import { stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CallExpression, Statement } from '@babel/types'
import { memberKeyName, objectLiteral, walk } from './ast-walk'
import {
  discoverModuleRoutesFiles,
  discoverRoutesFiles,
  fileExists,
  findFirstExisting,
  formatTruncatedList,
  moduleRoutesEntryCandidates,
  toPosixRelative,
} from './discovery'
import type { ParseCache } from './parse-cache'
import { DEFAULT_ROUTES_FILE, isRegistrarExportName, resolveRoutesEntry, specifierName } from './route-registrar'
import { pascalCase, referencesIdentifier, relativeImportPath } from './utils'
import { check, type CheckResult } from './check-result'

/** The directory whose files this check asks about, per scope. */
const ROUTES_DIR = 'routes'

/**
 * A path that can move a module scope's answer: its descriptor (where
 * `defineModule({ routes })` names the registrar), its routes entry, or its routes/.
 */
const MODULE_WIRING_PATTERN = /^modules\/[^/]+\/(?:index\.|routes[/.])/u

/**
 * Whether a changed path — POSIX-relative, as `getChangedFiles` reports — could move this
 * check's answer, and so must wake it under `--changed`. Gated as a unit rather than
 * filtered by changed candidate: the edit that unmounts `routes/admin.ts` is usually to
 * `routes/web.ts`. Both halves of each scope count — `modules/billing/routes/foo.ts` does
 * not start with `routes/`, and deleting `routes:` from a descriptor 404s every route.
 */
export function affectsRouteWiring(file: string, routesFile?: string): boolean {
  return (
    file === ROUTES_DIR
    || file.startsWith(`${ROUTES_DIR}/`)
    || file === routesFile
    || MODULE_WIRING_PATTERN.test(file)
  )
}

/** Stands in for "every export"; safe as a sentinel because `*` is not a legal export name. */
const EVERY_EXPORT = '*'

/** Extensions a specifier without one may resolve to, in preference order. */
const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']

/**
 * Source extension → the runtime extension it is emitted as. Used in both directions:
 * backwards, because apps following Node's ESM rules import the *emitted* path
 * (`routes/web.ts` names `'./auth.js'` for a file on disk called `auth.ts`), so a
 * resolver trying only the specifier as written finds no edges at all; forwards, to
 * print a suggested import line and to recognize an emitted `auth.js` as a build artifact.
 */
const SOURCE_TO_RUNTIME_EXTENSION: Record<string, string> = {
  '.ts': '.js',
  '.tsx': '.jsx',
  '.mts': '.mjs',
}

const RUNTIME_TO_SOURCE_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(SOURCE_TO_RUNTIME_EXTENSION).map(([source, runtime]) => [runtime, source]),
)

/** `path` with its extension swapped per `map`, or `null` if it isn't in `map`. */
function swapExtension(path: string, map: Record<string, string>): string | null {
  const extension = extname(path)
  const swapped = map[extension]
  return swapped ? `${path.slice(0, -extension.length)}${swapped}` : null
}

/** A name a file binds from another file, and the export it came from. */
interface ImportBinding {
  local: string
  /** The imported export's name, `'default'`, or {@link EVERY_EXPORT}. */
  imported: string
  /**
   * Absolute path of the file the specifier resolved to, or `null` for a specifier that
   * leaves `routes/` — kept, because the local name still matters to the collision note
   * in {@link wiringSuggestion}.
   */
  from: string | null
}

/** An `export ... from './x'` edge: `exported` here is `imported` there. */
interface ReexportEdge {
  exported: string
  imported: string
  from: string
}

/**
 * One routes file, reduced to what deciding "is this registrar called?" needs. The
 * body/import split (as in `console-check.ts`) exists because an import alone is not a
 * use: a leftover import whose call was deleted is exactly what this check reports.
 */
interface RoutesFileFacts {
  /** Exports the file itself declares that the route loader would accept. */
  registrarExports: string[]
  imports: ImportBinding[]
  reexports: ReexportEdge[]
  /** Files reached by `await import('./x.js')`, which binds no static name. */
  dynamicImports: string[]
  /** Top-level statements minus imports and `... from` re-exports. */
  body: string
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Absolute path a specifier points at, before extension guessing: relative to the
 * importing file, or to the app root for the `@/` alias. Package specifiers yield `null`.
 * Pure string work, kept apart from {@link resolveSpecifier} so callers can rule an edge
 * out before touching the disk — 16 of 17 probes in `examples/blog`.
 */
function specifierBase(cwd: string, fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier)
  if (specifier.startsWith('@/')) return resolve(cwd, specifier.slice(2))
  return null
}

/**
 * The file `base` names, or `null` when it names nothing on disk. Existence is probed
 * rather than assumed: a specifier resolving nowhere must not create a graph edge, or a
 * typo'd import would read as wiring.
 */
async function resolveSpecifier(base: string): Promise<string | null> {
  const source = swapExtension(base, RUNTIME_TO_SOURCE_EXTENSION)
  const candidates = [
    // Ahead of the specifier as written, so a TypeScript app that also has a
    // stale compiled `auth.js` beside `auth.ts` is read from source.
    ...(source === null ? [] : [source]),
    base,
    ...RESOLVED_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...RESOLVED_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ]

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate
  }

  return null
}

/**
 * Whether an `export default` declaration is something the loader would call. It takes
 * the default only when `typeof` it is a function (`load-routes.ts`), so a default that
 * is a plain object is not a registrar. An `Identifier` counts:
 * `export default registerAdminRoutes` is what every `guren add` scaffold writes.
 */
function isDefaultRegistrar(declaration: { type: string }): boolean {
  return (
    declaration.type === 'FunctionDeclaration'
    || declaration.type === 'FunctionExpression'
    || declaration.type === 'ArrowFunctionExpression'
    || declaration.type === 'Identifier'
  )
}

/**
 * Registrar-shaped exports a statement declares *itself*. A re-export is deliberately
 * not one: reporting the barrel would name a file whose only fix is in another one.
 */
function declaredRegistrarExports(node: Statement): string[] {
  if (node.type === 'ExportDefaultDeclaration') {
    return isDefaultRegistrar(node.declaration) ? ['default'] : []
  }
  if (node.type !== 'ExportNamedDeclaration' || node.source) return []
  if (node.exportKind === 'type') return []

  const names: string[] = []
  const declaration = node.declaration

  if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
    names.push(declaration.id.name)
  } else if (declaration?.type === 'VariableDeclaration') {
    for (const declarator of declaration.declarations) {
      if (declarator.id.type === 'Identifier') names.push(declarator.id.name)
    }
  }

  for (const specifier of node.specifiers) {
    if (specifier.type === 'ExportSpecifier') names.push(specifierName(specifier.exported))
  }

  return names.filter(isRegistrarExportName)
}

/** Files `await import('./x.js')` reaches, for the edges no static name records. */
async function dynamicImportTargets(
  program: unknown,
  resolveEdge: (specifier: string) => Promise<string | null>,
): Promise<string[]> {
  const specifiers: string[] = []

  walk(program, (node) => {
    if (node.type !== 'CallExpression') return
    const callee = node.callee as { type?: string } | undefined
    const [argument] = (node.arguments ?? []) as Array<{ type?: string; value?: unknown }>
    if (callee?.type === 'Import' && argument?.type === 'StringLiteral' && typeof argument.value === 'string') {
      specifiers.push(argument.value)
    }
  })

  const resolved = await Promise.all(specifiers.map(resolveEdge))
  return resolved.filter((file): file is string => file !== null)
}

async function readFacts(
  cwd: string,
  cache: ParseCache,
  filePath: string,
  boundary: string,
): Promise<RoutesFileFacts | null> {
  const parsed = await cache.get(filePath)
  if (!parsed) return null

  const facts: RoutesFileFacts = { registrarExports: [], imports: [], reexports: [], dynamicImports: [], body: '' }
  const bodyNodes: Statement[] = []

  // Only an edge landing inside the scope's boundary can change an answer, so
  // everything else is ruled out by string comparison before any filesystem
  // probe.
  const resolveEdge = async (specifier: string): Promise<string | null> => {
    const base = specifierBase(cwd, filePath, specifier)
    return base !== null && isInside(boundary, base) ? resolveSpecifier(base) : null
  }

  for (const node of parsed.ast.program.body) {
    if (node.type === 'ImportDeclaration') {
      // A type-only import compiles away — it can never mount anything.
      if (node.importKind === 'type') continue
      const from = await resolveEdge(node.source.value)

      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportDefaultSpecifier') {
          facts.imports.push({ local: specifier.local.name, imported: 'default', from })
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
          facts.imports.push({ local: specifier.local.name, imported: EVERY_EXPORT, from })
        } else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') {
          facts.imports.push({ local: specifier.local.name, imported: specifierName(specifier.imported), from })
        }
      }
      continue
    }

    if (node.type === 'ExportAllDeclaration') {
      const from = await resolveEdge(node.source.value)
      if (from !== null) facts.reexports.push({ exported: EVERY_EXPORT, imported: EVERY_EXPORT, from })
      continue
    }

    if (node.type === 'ExportNamedDeclaration' && node.source) {
      const from = await resolveEdge(node.source.value)
      if (from === null) continue
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ExportSpecifier') {
          facts.reexports.push({
            exported: specifierName(specifier.exported),
            imported: specifierName(specifier.local),
            from,
          })
        } else if (specifier.type === 'ExportNamespaceSpecifier') {
          facts.reexports.push({ exported: specifierName(specifier.exported), imported: EVERY_EXPORT, from })
        }
      }
      continue
    }

    bodyNodes.push(node)
    facts.registrarExports.push(...declaredRegistrarExports(node))
  }

  facts.body = bodyNodes.map((node) => parsed.source.slice(node.start ?? 0, node.end ?? 0)).join('\n')
  facts.dynamicImports = await dynamicImportTargets(parsed.ast.program, resolveEdge)

  return facts
}

/** Whether `filePath` sits inside `directory`. */
function isInside(directory: string, filePath: string): boolean {
  const rel = relative(directory, filePath)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export interface RoutesCheckOptions {
  cwd: string
  cache: ParseCache
  /**
   * `--routes <file>`, project-relative; omitted, the entry is probed from
   * {@link ROUTES_ENTRY_CANDIDATES}. Project scope only — a module's entry is its own file.
   */
  routesFile?: string
}

/**
 * One "which registrar mounts these?" question and everything answering it needs — the
 * project asks one, each module with a `routes/` directory asks another. Kept whole
 * because nothing may leak across scopes: a shared candidate list or `facts` map would
 * let a file credit another module's registrar and report as mounted.
 */
interface WiringScope {
  /** Module name, or `null` for the project itself — wording only. */
  module: string | null
  /** Project-relative entry file whose registrar mounts this scope. */
  entryFile: string
  /**
   * Absolute `routes/` directory bounding graph traversal. It bounds the *target* of an
   * import, not the importing file: a module's entry sits beside the directory, and its
   * `./routes/invoice.js` edge is followed all the same.
   */
  boundary: string
  /** Absolute paths of every routes file this scope asks about. */
  files: string[]
}

/** How a module names its routes registrar, read from its descriptor. */
type ModuleEntryResolution =
  /** `defineModule({ routes })` traced to a file — the scope's entry. */
  | { kind: 'entry'; entryPath: string }
  /** The descriptor's `defineModule()` positively names no `routes`. */
  | { kind: 'unwired'; descriptor: string }
  /** `routes` is set but not traceable to a file; judging would be a guess. */
  | { kind: 'opaque' }
  /** No parseable descriptor — fall back to the conventional entry files. */
  | { kind: 'fallback' }

/**
 * Resolves the file a module's `defineModule({ routes })` takes its registrar from — the
 * same link the runtime follows, which is what makes it the scope entry rather than any
 * conventionally named file. Misses rather than invents: a `routes` value this cannot
 * trace yields `opaque`, which skips the module, and a spread in the descriptor makes an
 * absent `routes` property `opaque` too rather than `unwired`.
 */
async function resolveModuleEntry(
  cwd: string,
  cache: ParseCache,
  moduleDir: string,
): Promise<ModuleEntryResolution> {
  const relDir = toPosixRelative(cwd, moduleDir)
  const descriptor = await findFirstExisting(cwd, [`${relDir}/index.ts`, `${relDir}/index.js`])
  if (descriptor === null) return { kind: 'fallback' }

  const descriptorPath = resolve(cwd, descriptor)
  const parsed = await cache.get(descriptorPath)
  if (!parsed) return { kind: 'fallback' }

  // Local name → import specifier, for tracing `routes: registerBillingRoutes`
  // back to the file that declared it.
  const importSources = new Map<string, string>()
  for (const node of parsed.ast.program.body) {
    if (node.type !== 'ImportDeclaration' || node.importKind === 'type') continue
    for (const specifier of node.specifiers) {
      importSources.set(specifier.local.name, node.source.value)
    }
  }

  let sawDefineModule = false
  let hasSpread = false
  let routesValue: { type?: string; name?: string } | null = null

  walk(parsed.ast.program, (node) => {
    if (sawDefineModule || node.type !== 'CallExpression') return
    const call = node as unknown as CallExpression
    if (call.callee.type !== 'Identifier' || call.callee.name !== 'defineModule') return
    // `defineModule({ … } satisfies ModuleDefinition)` describes the same module, so
    // unwrap before judging the argument's shape or the descriptor reads as absent.
    const argument = objectLiteral(call.arguments[0])
    if (!argument) return
    sawDefineModule = true

    for (const property of argument.properties) {
      if (property.type === 'SpreadElement') {
        hasSpread = true
        continue
      }
      // Computed keys answer `undefined` here, which is the skip this wants.
      if (memberKeyName(property) !== 'routes') continue
      // A method shorthand (`routes(router) {...}`) is an inline registrar, like an arrow.
      routesValue = property.type === 'ObjectMethod' ? { type: 'FunctionExpression' } : (property.value ?? null)
    }
  })

  if (!sawDefineModule) return { kind: 'fallback' }
  if (routesValue === null) return hasSpread ? { kind: 'opaque' } : { kind: 'unwired', descriptor }

  const value = routesValue as { type?: string; name?: string }
  // An inline registrar makes the descriptor itself the entry: its imports are the wiring.
  if (value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression') {
    return { kind: 'entry', entryPath: descriptorPath }
  }
  if (value.type !== 'Identifier' || !value.name) return { kind: 'opaque' }

  const source = importSources.get(value.name)
  // Not imported — declared in the descriptor itself.
  if (source === undefined) return { kind: 'entry', entryPath: descriptorPath }

  const base = specifierBase(cwd, descriptorPath, source)
  if (base === null) return { kind: 'opaque' }
  const resolved = await resolveSpecifier(base)
  return resolved === null ? { kind: 'opaque' } : { kind: 'entry', entryPath: resolved }
}

/**
 * The one warning an unwired module gets: its `routes/` files exist but the descriptor
 * names no registrar, so nothing is mounted. One result, since the fix is in the descriptor.
 */
function unwiredModuleResult(cwd: string, module: string, descriptor: string, files: string[]): CheckResult {
  const shown = withoutEmittedTwins(files).map((file) => toPosixRelative(cwd, file))
  const registrar = `register${pascalCase(module)}Routes`

  return check(
    `route-entry:${descriptor}`,
    `${module} route registrar entrypoint`,
    'warn',
    `${formatTruncatedList(shown)} ${shown.length === 1 ? 'exists' : 'exist'} but ${descriptor} names no routes `
    + `registrar in defineModule(), so nothing mounts ${shown.length === 1 ? 'it' : 'them'} and every request to `
    + `${shown.length === 1 ? 'its' : 'their'} routes 404s.`,
    `Add routes: ${registrar} to defineModule() in ${descriptor} (create modules/${module}/routes.ts exporting it `
    + `if needed), then call each routes file's registrar from it.`,
  )
}

/**
 * Verifies every registrar under a `routes/` directory is reached from the entry registrar
 * that would mount it — nothing else does, and the only symptom is a 404. Asked once per
 * {@link WiringScope}, which share no state, or a file would count another module's
 * registrar. Mounting spreads outward from the entry and is *named*: a file counts only
 * once an already-mounted file uses one of its registrar exports. `warn`: it misses, never invents.
 */
export async function checkRouteRegistrarWiring(options: RoutesCheckOptions): Promise<CheckResult[]> {
  const { cwd, cache } = options

  // An explicit `--routes` is honoured even when it names a file that doesn't exist —
  // reporting that is the point. Otherwise probe, per ROUTES_ENTRY_CANDIDATES.
  const entryFile = options.routesFile ?? (await resolveRoutesEntry(cwd)) ?? DEFAULT_ROUTES_FILE

  const results = await checkScope(cwd, cache, {
    module: null,
    entryFile,
    boundary: resolve(cwd, ROUTES_DIR),
    files: await discoverRoutesFiles(cwd),
  })

  for (const { module, dir, files } of await discoverModuleRoutesFiles(cwd)) {
    const resolution = await resolveModuleEntry(cwd, cache, dir)
    if (resolution.kind === 'opaque') continue
    if (resolution.kind === 'unwired') {
      results.push(unwiredModuleResult(cwd, module, resolution.descriptor, files))
      continue
    }

    const entries = moduleRoutesEntryCandidates(toPosixRelative(cwd, dir))
    const scopeResults = await checkScope(cwd, cache, {
      module,
      entryFile:
        resolution.kind === 'entry'
          ? toPosixRelative(cwd, resolution.entryPath)
          // Fallback: the conventional name stands in when none exists, so the
          // warning below names the file to create rather than its absence.
          : ((await findFirstExisting(cwd, entries)) ?? entries[0]),
      boundary: resolve(dir, ROUTES_DIR),
      files,
    })
    results.push(...scopeResults)
  }

  return results
}

/** {@link checkRouteRegistrarWiring} for one scope — see {@link WiringScope}. */
async function checkScope(cwd: string, cache: ParseCache, scope: WiringScope): Promise<CheckResult[]> {
  const { entryFile, module } = scope
  const entryPath = resolve(cwd, entryFile)

  const candidates = withoutEmittedTwins(scope.files)
    // By resolved path, not by name: `--routes` may point anywhere, and a module keeping
    // its registrar at `routes/index.ts` has its entry sitting among the files it mounts.
    .filter((filePath) => filePath !== entryPath)
    .sort()

  if (candidates.length === 0) return []

  const entryKey = `route-entry:${entryFile}`
  const entryTitle = module ? `${module} route registrar entrypoint` : 'Route registrar entrypoint'
  const describeCandidates = (): string => formatTruncatedList(candidates.map((file) => toPosixRelative(cwd, file)))

  // Probed separately because `readFacts` returns null for a missing file and
  // an unparseable one alike, and those want different advice.
  if (!(await fileExists(cwd, entryFile))) {
    return [
      check(
        entryKey,
        entryTitle,
        'warn',
        `${describeCandidates()} ${candidates.length === 1 ? 'exists' : 'exist'} but there is no ${entryFile} to `
        + `mount ${candidates.length === 1 ? 'it' : 'them'} from.`,
        `Create ${entryFile} exporting a register*Routes function, then call each routes file's registrar from it.`
        // Both hops, since a module registrar the module never declares mounts
        // nothing either.
        + (module ? ` Name it in ${module}'s defineModule({ routes }).` : ''),
      ),
    ]
  }

  const facts = new Map<string, RoutesFileFacts>()
  for (const filePath of [entryPath, ...candidates]) {
    const read = await readFacts(cwd, cache, filePath, scope.boundary)
    if (read) facts.set(filePath, read)
  }

  const entryFacts = facts.get(entryPath)

  if (!entryFacts) {
    // One warning, not one per candidate: fanning it out would read as every routes
    // file being broken.
    return [
      check(
        entryKey,
        entryTitle,
        'warn',
        `${entryFile} could not be parsed, so ${describeCandidates()} cannot be verified as mounted.`,
        `Check ${entryFile} for a syntax error.`,
        entryFile,
      ),
    ]
  }

  const mounted = mountedFrom(facts, entryPath, entryFacts)
  const entryBindings = new Set(entryFacts.imports.map((binding) => binding.local))

  return candidates.flatMap((filePath) => {
    const candidateFacts = facts.get(filePath)
    // A routes file exporting no registrar is a helper; an unparseable one is already
    // reported by the shared `scan-coverage` warning.
    if (!candidateFacts || candidateFacts.registrarExports.length === 0) return []

    const relPath = toPosixRelative(cwd, filePath)
    const isMounted = mounted.has(filePath)
    const name = candidateFacts.registrarExports.find((exported) => exported !== 'default')

    return check(
      `route-registrar:${relPath}`,
      `${relPath} wiring`,
      isMounted ? 'pass' : 'warn',
      isMounted
        ? `${relPath}'s registrar is called from ${entryFile}.`
        : `${relPath} exports a route registrar that nothing reachable from ${entryFile} calls, `
          + 'so its routes are never mounted and every request to them 404s.',
      isMounted ? undefined : wiringSuggestion(cwd, entryFile, filePath, relPath, name, entryBindings),
      relPath,
    )
  })
}

/**
 * Drops an emitted `auth.js` sitting beside the `auth.ts` it was built from. Left in, the
 * artifact is a second candidate nothing imports, so an in-place TypeScript build would
 * turn a working `routes/` into a failing check.
 */
function withoutEmittedTwins(files: string[]): string[] {
  const present = new Set(files)
  return files.filter((file) => {
    const source = swapExtension(file, RUNTIME_TO_SOURCE_EXTENSION)
    return source === null || !present.has(source)
  })
}

/** Files whose registrar the app will actually call, spreading outward from the entry. */
function mountedFrom(
  facts: Map<string, RoutesFileFacts>,
  entryPath: string,
  entryFacts: RoutesFileFacts,
): Set<string> {
  const mounted = new Set<string>([entryPath])
  const pending = [entryPath]
  const credited = new Set<string>()

  const mount = (file: string): void => {
    if (mounted.has(file)) return
    mounted.add(file)
    pending.push(file)
  }

  /** Credits `file` with `name`, following `export ... from` edges through barrels. */
  const credit = (file: string, name: string): void => {
    const visit = `${file} ${name}`
    if (credited.has(visit)) return
    credited.add(visit)

    const forwarded = facts.get(file)
    const declares = name === EVERY_EXPORT
      ? (forwarded?.registrarExports.length ?? 0) > 0
      : forwarded?.registrarExports.includes(name)
    if (declares) mount(file)
    if (!forwarded) return

    if (name === EVERY_EXPORT) {
      for (const edge of forwarded.reexports) credit(edge.from, edge.imported)
      return
    }

    // An explicit named re-export shadows every `export *` in the same file, per ES
    // semantics — following both would credit a file the barrel deliberately overrides.
    const explicit = forwarded.reexports.filter((edge) => edge.exported === name)
    if (explicit.length > 0) {
      for (const edge of explicit) credit(edge.from, edge.imported)
      return
    }

    for (const edge of forwarded.reexports) {
      if (edge.exported === EVERY_EXPORT) credit(edge.from, name)
    }
  }

  // The loader resolves a registrar from the entry file's *exports*, so a forwarded one
  // is called just as surely as one the entry declares.
  for (const edge of entryFacts.reexports) {
    if (edge.exported === EVERY_EXPORT || isRegistrarExportName(edge.exported)) {
      credit(edge.from, edge.imported)
    }
  }

  while (pending.length > 0) {
    const file = pending.shift() as string
    const source = facts.get(file)
    if (!source) continue

    for (const binding of source.imports) {
      if (binding.from !== null && referencesIdentifier(source.body, binding.local)) {
        credit(binding.from, binding.imported)
      }
    }
    // A dynamic import has no static local to look for — the import itself is the use.
    for (const target of source.dynamicImports) credit(target, EVERY_EXPORT)
  }

  return mounted
}

/**
 * The import-and-call line to add, spelled out: nothing regenerates the wiring for a
 * routes file that already exists.
 */
function wiringSuggestion(
  cwd: string,
  entryFile: string,
  filePath: string,
  relPath: string,
  name: string | undefined,
  entryBindings: Set<string>,
): string {
  const tail = `and call it from your route registrar, passing that registrar's router.`

  if (name === undefined) {
    // Default-only export: there is no name to spell, so name the file.
    return `Import the default export of ${relPath} in ${entryFile} ${tail}`
  }

  // Printed with the runtime extension the app's own imports use, so it can be pasted.
  const printed = relativeImportPath(resolve(cwd, entryFile), filePath)
  const specifier = swapExtension(printed, SOURCE_TO_RUNTIME_EXTENSION) ?? printed

  // Two `make:route` files both export `registerRoutes`, so the obvious import
  // line does not always compile as written.
  const collision = entryBindings.has(name)
    ? ` (under an alias — ${entryFile} already binds ${name})`
    : ''

  return `Add to ${entryFile}: import { ${name} } from '${specifier}'${collision}, ${tail}`
}
