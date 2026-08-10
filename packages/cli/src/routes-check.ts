import { stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Statement } from '@babel/types'
import { walk } from './ast-walk'
import { discoverRoutesFiles, fileExists, findFirstExisting, formatTruncatedList, toPosixRelative } from './discovery'
import type { ParseCache } from './parse-cache'
import { DEFAULT_ROUTES_FILE, isRegistrarExportName, ROUTES_ENTRY_CANDIDATES, specifierName } from './route-registrar'
import { referencesIdentifier, relativeImportPath } from './utils'
import { check, type CheckResult } from './check-result'

/** The directory whose files this check asks about. */
export const ROUTES_DIR = 'routes'

/**
 * Stands in for "every export", for `import * as routes` and
 * `export * from './x'`. Safe as a sentinel because `*` is not a legal
 * export name.
 */
const EVERY_EXPORT = '*'

/** Extensions a specifier without one may resolve to, in preference order. */
const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']

/**
 * Source extension → the runtime extension it is emitted as.
 *
 * Load-bearing in both directions, not a nicety. Read backwards, it is how a
 * specifier reaches its file: apps following Node's ESM rules import the
 * *emitted* path, so `routes/web.ts` names its sibling `'./auth.js'` while
 * the file on disk is `auth.ts` — the shape `examples/blog` and every `guren
 * add` scaffold use. A resolver that only tried the specifier as written
 * would find no edges at all in a real app and report every routes file as
 * unmounted. Read forwards, it is how a suggested import line is printed, and
 * how an emitted `auth.js` sitting beside its own `auth.ts` is recognized as
 * a build artifact rather than a second routes file.
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
   * Absolute path of the file the specifier resolved to, or `null` for a
   * specifier that leaves `routes/`. Those bindings are kept rather than
   * dropped because the local name still matters for the collision note in
   * {@link wiringSuggestion} — only the filesystem probe is skipped.
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
 * One routes file, reduced to what deciding "is this registrar called?" needs.
 *
 * The body/import split is the same one `console-check.ts` makes, for the same
 * reason: an import alone is not a use. A `routes/web.ts` left holding
 * `import registerAdminRoutes from './admin.js'` after someone deleted the
 * call is exactly the state this check exists to report, and it is
 * indistinguishable from wired-up unless the two halves are kept apart.
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
 * Absolute path a specifier points at, before extension guessing: relative to
 * the importing file, or to the app root for the `@/` alias the templates
 * configure. Package specifiers yield `null` — nothing outside the app can
 * mount a routes file.
 *
 * Pure string work, which is what makes it worth having separately from
 * {@link resolveSpecifier}: only an edge landing inside `routes/` can change
 * an answer here, so callers rule the rest out before touching the disk. In
 * `examples/blog` that is 16 of 17 filesystem probes not made — the entry
 * file's controller, model, and validator imports.
 */
function specifierBase(cwd: string, fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier)
  if (specifier.startsWith('@/')) return resolve(cwd, specifier.slice(2))
  return null
}

/**
 * The file `base` names, or `null` when it names nothing on disk.
 *
 * Existence is probed rather than assumed (unlike `spec-modules.ts`, which
 * only needs a path prefix for attribution): a specifier that resolves
 * nowhere must not create a graph edge, or a typo'd import would read as
 * wiring.
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
 * Whether an `export default` declaration is something the loader would call.
 *
 * The loader takes the default export only when `typeof` it is a function
 * (`load-routes.ts`), so counting every default export would report a
 * `routes/prefixes.ts` whose default is a plain object as an unmounted
 * registrar. An `Identifier` counts because `export default registerAdminRoutes`
 * — what every `guren add` scaffold writes — is the common indirection.
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
 * Registrar-shaped exports a statement declares *itself*. A re-export
 * (`export { registerAdminRoutes } from './admin.js'`) is deliberately not
 * one: a barrel that forwards a registrar does not own it, and reporting the
 * barrel would name a file whose only fix is in another one.
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
  routesDir: string,
): Promise<RoutesFileFacts | null> {
  const parsed = await cache.get(filePath)
  if (!parsed) return null

  const facts: RoutesFileFacts = { registrarExports: [], imports: [], reexports: [], dynamicImports: [], body: '' }
  const bodyNodes: Statement[] = []

  // Only an edge landing inside `routes/` can change an answer, so everything
  // else is ruled out by string comparison before any filesystem probe.
  const resolveEdge = async (specifier: string): Promise<string | null> => {
    const base = specifierBase(cwd, filePath, specifier)
    return base !== null && isInside(routesDir, base) ? resolveSpecifier(base) : null
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
   * `--routes <file>`, project-relative. Omitted, the entry is probed from
   * {@link ROUTES_ENTRY_CANDIDATES} rather than assumed.
   */
  routesFile?: string
}

/**
 * Verifies every registrar under `routes/` is reached from the app's entry
 * registrar — the wiring `guren add admin|oauth|resource|auth` performs
 * automatically, so a warning here means a routes file was written, moved, or
 * unhooked by hand (`make:route`, notably, writes its file and leaves the
 * wiring to you).
 *
 * Nothing else reports this. A routes file nobody imports still compiles,
 * still type-checks, and still looks wired from the inside — the only symptom
 * is a 404 in production, which is why the scaffolders' own regex matching
 * only a registrar parameter literally named `router` went unnoticed against
 * the blog template's `baseRouter`. Fixing the scaffolders does nothing for
 * the apps already in that state; this does.
 *
 * Mounting spreads outward from the entry file rather than over everything
 * parsed, and it is *named*: a file is mounted only once some already-mounted
 * file uses a binding that traces back to one of its registrar exports. Both
 * halves are load-bearing. Crediting a whole file for any binding would pass
 * an `admin.ts` whose `ADMIN_PREFIX` constant is imported while its registrar
 * is not; crediting from any parsed file would pass an `admin.ts` called only
 * by a `group.ts` that nothing calls in turn.
 *
 * "Uses" is a name reference outside the file's imports (see
 * {@link referencesIdentifier}), not a call expression — a registrar can be
 * handed onward as a value. That looseness runs one way: a name in a comment
 * or a string reads as used, so this can miss an orphan but not invent one.
 * `warn` rather than `fail` for the same reason.
 *
 * Two wirings it cannot see, both reported as unmounted: a chain that leaves
 * `routes/` (`web.ts` → `app/routing.ts` → `routes/admin.ts`), since
 * following it means parsing the project to answer a question about a handful
 * of files; and a registrar reached by anything less direct than an import or
 * `await import()` of its file.
 *
 * Not filtered by changed *candidates*, unlike `runCheck`'s file-scanning
 * checks: the edit that breaks the wiring is to `routes/web.ts`, not to
 * `routes/admin.ts`. `runCheck` instead gates the whole check on `routes/`
 * having changed, which covers both. Content-activated — an app whose
 * `routes/` holds nothing but the entry file contributes zero results.
 */
export async function checkRouteRegistrarWiring(options: RoutesCheckOptions): Promise<CheckResult[]> {
  const { cwd, cache } = options
  const routesDir = resolve(cwd, ROUTES_DIR)

  // An explicit `--routes` is honoured as given, including when it names a
  // file that doesn't exist — reporting that is the point. Otherwise probe,
  // for the reason ROUTES_ENTRY_CANDIDATES documents.
  const entryFile = options.routesFile ?? (await findFirstExisting(cwd, ROUTES_ENTRY_CANDIDATES)) ?? DEFAULT_ROUTES_FILE
  const entryPath = resolve(cwd, entryFile)

  const routesFiles = await discoverRoutesFiles(cwd)
  const candidates = withoutEmittedTwins(routesFiles)
    // By resolved path, not by name: `--routes` may point anywhere, and under
    // a custom entry `routes/web.ts` is an ordinary candidate.
    .filter((filePath) => filePath !== entryPath)
    .sort()

  if (candidates.length === 0) return []

  const entryKey = `route-entry:${entryFile}`
  const entryTitle = 'Route registrar entrypoint'
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
        `Create ${entryFile} exporting a register*Routes function, then call each routes file's registrar from it.`,
      ),
    ]
  }

  const facts = new Map<string, RoutesFileFacts>()
  for (const filePath of [entryPath, ...candidates]) {
    const read = await readFacts(cwd, cache, filePath, routesDir)
    if (read) facts.set(filePath, read)
  }

  const entryFacts = facts.get(entryPath)

  if (!entryFacts) {
    // One warning, not one per candidate: an unparseable entry is a single
    // fact about a single file, and fanning it out would read as every routes
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
    // A routes file exporting no registrar is a helper, not something the
    // loader could mount; an unparseable one is already reported by the
    // shared `scan-coverage` warning.
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
 * Drops an emitted `auth.js` sitting beside the `auth.ts` it was built from.
 *
 * The pair is one routes file, and the specifier resolver already prefers the
 * source. Left in, the artifact is a second candidate that nothing imports by
 * that path — so an in-place TypeScript build would turn a working `routes/`
 * into a failing check.
 */
function withoutEmittedTwins(files: string[]): string[] {
  const present = new Set(files)
  return files.filter((file) => {
    const source = swapExtension(file, RUNTIME_TO_SOURCE_EXTENSION)
    return source === null || !present.has(source)
  })
}

/**
 * Files whose registrar the app will actually call, spreading outward from
 * the entry.
 */
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

  /**
   * Credits `file` with `name` being used, following `export ... from` edges
   * so a barrel forwards the credit to whichever file actually declares the
   * registrar.
   */
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

    // An explicit named re-export shadows every `export *` in the same file,
    // per ES semantics — following both would credit a `legacy-admin.ts` the
    // barrel deliberately overrides.
    const explicit = forwarded.reexports.filter((edge) => edge.exported === name)
    if (explicit.length > 0) {
      for (const edge of explicit) credit(edge.from, edge.imported)
      return
    }

    for (const edge of forwarded.reexports) {
      if (edge.exported === EVERY_EXPORT) credit(edge.from, name)
    }
  }

  // The loader resolves a registrar from the entry file's *exports*, so one
  // the entry merely forwards (`export * from './admin.js'`) is called just
  // as surely as one it declares.
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
    // A dynamic import binds its names by destructuring the awaited module,
    // so there is no static local to look for — the import itself is the use.
    for (const target of source.dynamicImports) credit(target, EVERY_EXPORT)
  }

  return mounted
}

/**
 * The import-and-call line to add, spelled out rather than described: this is
 * the user's only guidance, since nothing regenerates the wiring for a routes
 * file that already exists.
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

  // Printed with the runtime extension the app's own imports use, so the line
  // can be pasted rather than adapted.
  const printed = relativeImportPath(resolve(cwd, entryFile), filePath)
  const specifier = swapExtension(printed, SOURCE_TO_RUNTIME_EXTENSION) ?? printed

  // Two `make:route` files both export `registerRoutes`, so the obvious import
  // line does not always compile as written.
  const collision = entryBindings.has(name)
    ? ` (under an alias — ${entryFile} already binds ${name})`
    : ''

  return `Add to ${entryFile}: import { ${name} } from '${specifier}'${collision}, ${tail}`
}
