/**
 * Every named import in a docs snippet must name a symbol its specifier exports.
 * Imports are extracted textually, one statement at a time: 67 of 1286 TS fences
 * are fragments whose AST reports zero imports. `crossCheckExtraction()` fails the
 * gate when text and AST disagree on a cleanly parsing fence (1219/1219 agree).
 * The surface is the `exports` entry point, followed transitively; type and value
 * names share one set, so absence is sound but "is a value" is never claimed.
 * Unresolvable fails; an open surface (`export *` from a third-party package) is
 * reported in `openEntryPoints`, never skipped. No top-level side effects.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, dirname, resolve } from 'node:path'
import { parse } from '@babel/parser'
import type { Statement } from '@babel/types'

/** A docs snippet imports a name its specifier does not export. */
export interface UnexportedSymbol {
  readonly location: string
  readonly symbol: string
  readonly specifier: string
  /** First-party entry points that do export this symbol, canonical order. */
  readonly exportedBy: readonly string[]
}

/** The gate could not reason about something. Never a silent pass. */
export interface UnresolvableImport {
  readonly location: string
  readonly specifier: string
  readonly reason: string
}

export interface DocsImportReport {
  readonly unexported: readonly UnexportedSymbol[]
  readonly unresolvable: readonly UnresolvableImport[]
  /** Entry points whose surface re-exports a third-party package wholesale. */
  readonly openEntryPoints: readonly string[]
  readonly fencesScanned: number
  readonly importsChecked: number
  readonly symbolsChecked: number
}

const FIRST_PARTY_SCOPE = '@guren/'

/**
 * One plugin list for both parses: a list that drifted between them would report
 * the parser disagreeing with itself as extractor blindness.
 */
const BABEL_PLUGINS = ['typescript', 'jsx', 'decorators-legacy', 'explicitResourceManagement'] as const

/**
 * A fenced block and the 1-based line its content starts on. The backreference
 * pins the closing fence to the opening fence's indentation, so a nested fence
 * inside an indented block does not close its parent early.
 */
const FENCE = /^([ \t]*)```([^\n`]*)\n([\s\S]*?)^\1```[ \t]*$/gm

// `js`/`jsx` too, though `docs/` has none today: a filter admitting only the
// tags in use would leave the first such snippet unchecked.
const TYPESCRIPT_FENCE = /^(ts|tsx|typescript|js|jsx|javascript)\b/

/**
 * An import statement, keyword through closing quote. `from` is optional so a
 * side-effect `import 'x'` is seen too, or `crossCheckExtraction()`'s whole-list
 * comparison reports a phantom mismatch. Excluding `;` and a backtick from the
 * span keeps a match from running past the end of its own statement.
 */
const IMPORT_STATEMENT = /^[ \t]*import\b(?:[^;`]*?from)?[ \t]*(['"])([^'"\n]+)\1/gm

interface EntryPoint {
  readonly specifier: string
  readonly packageDir: string
  /**
   * `asset` is a declared non-module target, importable for its side effect and
   * never for a name. `unresolved` is the failure: a declared `dist/` target
   * whose source cannot be found, reported even when no doc imports it.
   * Collapsing the two would report a renamed source as "that's a stylesheet".
   */
  readonly kind: 'module' | 'asset' | 'unresolved'
  readonly sourceFile: string | null
  readonly target: string
}

interface Surface {
  readonly names: ReadonlySet<string>
  /** Set when the surface re-exports a package this gate cannot enumerate. */
  readonly openedBy: string | null
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** The source file an extensionless base path stands for: three spellings. */
async function firstExistingSource(base: string): Promise<string | null> {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (await isFile(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * tsdown's output layout mirrors the source tree, so undoing `./dist/X.js` is a
 * path rewrite rather than a build-config read.
 */
async function sourceForDistTarget(packageDir: string, target: string): Promise<string | null> {
  if (!target.startsWith('./dist/')) {
    return null
  }
  const stem = target.slice('./dist/'.length).replace(/\.d\.ts$|\.js$/u, '')
  return firstExistingSource(join(packageDir, 'src', stem))
}

/**
 * Every `@guren/*` entry point, keyed by the specifier a snippet would write.
 * Derived from the `exports` maps, so a new subpath is covered when declared.
 */
export async function collectEntryPoints(root: string): Promise<Map<string, EntryPoint>> {
  const entryPoints = new Map<string, EntryPoint>()
  const packageDirs = await readdir(join(root, 'packages'), { withFileTypes: true })

  for (const dir of packageDirs) {
    if (!dir.isDirectory()) {
      continue
    }
    const packageDir = join(root, 'packages', dir.name)
    const manifestPath = join(packageDir, 'package.json')
    if (!(await isFile(manifestPath))) {
      continue
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      name?: string
      exports?: Record<string, string | Record<string, string>>
    }
    const name = manifest.name
    if (!name?.startsWith(FIRST_PARTY_SCOPE) || !manifest.exports) {
      continue
    }

    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const specifier = subpath === '.' ? name : `${name}${subpath.slice(1)}`
      // `./bin` declares only `default`; every other subpath carries `types`.
      const resolvedTarget = typeof target === 'string' ? target : (target.types ?? target.default)
      if (typeof resolvedTarget !== 'string') {
        entryPoints.set(specifier, { specifier, packageDir, kind: 'unresolved', sourceFile: null, target: JSON.stringify(target) })
        continue
      }
      // `./styles.css` and `./package.json` are assets, not modules. A named
      // import from one is an error; a side-effect import is fine, and only
      // named imports are checked.
      if (!resolvedTarget.startsWith('./dist/')) {
        entryPoints.set(specifier, { specifier, packageDir, kind: 'asset', sourceFile: null, target: resolvedTarget })
        continue
      }
      const sourceFile = await sourceForDistTarget(packageDir, resolvedTarget)
      entryPoints.set(specifier, {
        specifier,
        packageDir,
        kind: sourceFile ? 'module' : 'unresolved',
        sourceFile,
        target: resolvedTarget,
      })
    }
  }

  return entryPoints
}

function parseModule(source: string, path: string): Statement[] {
  try {
    return parse(source, {
      sourceType: 'module',
      plugins: [...BABEL_PLUGINS],
    }).program.body
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${(error as Error).message}`)
  }
}

/** Names bound by a declaration that carries `export`. */
function declaredNames(statement: Statement): string[] {
  if (statement.type !== 'ExportNamedDeclaration' || !statement.declaration) {
    return []
  }
  const declaration = statement.declaration
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap((entry) =>
      entry.id.type === 'Identifier' ? [entry.id.name] : [],
    )
  }
  if (
    declaration.type === 'FunctionDeclaration' ||
    declaration.type === 'ClassDeclaration' ||
    declaration.type === 'TSDeclareFunction' ||
    declaration.type === 'TSInterfaceDeclaration' ||
    declaration.type === 'TSTypeAliasDeclaration' ||
    declaration.type === 'TSEnumDeclaration' ||
    declaration.type === 'TSModuleDeclaration'
  ) {
    const id = declaration.id
    return id && id.type === 'Identifier' ? [id.name] : []
  }
  return []
}

/**
 * Resolve a relative re-export target to a source file. Sources are written
 * with `.js` extensions (`./attachments/index.js`) that resolve to `.ts`.
 */
async function resolveRelative(fromFile: string, specifier: string): Promise<string | null> {
  return firstExistingSource(resolve(dirname(fromFile), specifier).replace(/\.js$/u, ''))
}

class SurfaceResolver {
  private readonly fileCache = new Map<string, Surface>()
  private readonly entryCache = new Map<string, Surface>()
  private readonly visiting = new Set<string>()

  constructor(private readonly entryPoints: Map<string, EntryPoint>) {}

  /**
   * The export surface of a first-party entry point, or null when the specifier
   * is not one. Throws on a declared entry point it cannot read: an underivable
   * surface is a gate failure, not an empty set.
   */
  async forSpecifier(specifier: string): Promise<Surface | null> {
    const entryPoint = this.entryPoints.get(specifier)
    if (!entryPoint) {
      return null
    }
    const cached = this.entryCache.get(specifier)
    if (cached) {
      return cached
    }
    if (entryPoint.kind === 'asset' || !entryPoint.sourceFile) {
      throw new Error(
        entryPoint.kind === 'asset'
          ? `${specifier} resolves to '${entryPoint.target}', a static asset rather than a TypeScript module — it has no named exports`
          : `${specifier} declares '${entryPoint.target}' in its exports map, but no matching source exists under src/`,
      )
    }
    const surface = await this.forFile(entryPoint.sourceFile)
    this.entryCache.set(specifier, surface)
    return surface
  }

  private async forFile(file: string): Promise<Surface> {
    const cached = this.fileCache.get(file)
    if (cached) {
      return cached
    }
    // A re-export cycle contributes no names of its own; the outer frame that
    // is still resolving the file will supply them.
    if (this.visiting.has(file)) {
      return { names: new Set(), openedBy: null }
    }
    this.visiting.add(file)
    try {
      const surface = await this.readFile(file)
      this.fileCache.set(file, surface)
      return surface
    } finally {
      this.visiting.delete(file)
    }
  }

  private async readFile(file: string): Promise<Surface> {
    const body = parseModule(await readFile(file, 'utf8'), file)
    const names = new Set<string>()
    let openedBy: string | null = null

    const absorb = async (target: string, statementLabel: string): Promise<void> => {
      let inner: Surface
      if (target.startsWith('.')) {
        const resolved = await resolveRelative(file, target)
        if (!resolved) {
          throw new Error(`${file}: ${statementLabel} targets '${target}', which does not resolve to a source file`)
        }
        inner = await this.forFile(resolved)
      } else if (target.startsWith(FIRST_PARTY_SCOPE)) {
        const sibling = await this.forSpecifier(target)
        if (!sibling) {
          throw new Error(`${file}: ${statementLabel} targets '${target}', which is not a declared entry point`)
        }
        inner = sibling
      } else {
        // A third-party wholesale re-export. The names cannot be enumerated from
        // first-party source, so absence stops being provable here.
        openedBy ??= target
        return
      }

      for (const name of inner.names) {
        names.add(name)
      }
      openedBy ??= inner.openedBy
    }

    for (const statement of body) {
      if (statement.type === 'ExportDefaultDeclaration') {
        names.add('default')
        continue
      }
      if (statement.type === 'ExportAllDeclaration') {
        await absorb(statement.source.value, `export * from '${statement.source.value}'`)
        continue
      }
      if (statement.type !== 'ExportNamedDeclaration') {
        continue
      }
      for (const name of declaredNames(statement)) {
        names.add(name)
      }
      for (const specifier of statement.specifiers) {
        // `export { a as b }`, `export { a as 'b' }`, `export * as ns from`.
        if (specifier.type === 'ExportSpecifier' || specifier.type === 'ExportNamespaceSpecifier') {
          const exported = specifier.exported
          names.add(exported.type === 'Identifier' ? exported.name : exported.value)
        } else if (specifier.type === 'ExportDefaultSpecifier') {
          names.add(specifier.exported.name)
        }
      }
    }

    return { names, openedBy }
  }
}

interface ExtractedImport {
  readonly specifier: string
  readonly statement: string
  readonly line: number
}

function lineOf(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (source[i] === '\n') {
      line += 1
    }
  }
  return line
}

/** Every TypeScript fence in a markdown file, with its starting line. */
export function typescriptFences(markdown: string): { code: string; line: number }[] {
  const fences: { code: string; line: number }[] = []
  FENCE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCE.exec(markdown))) {
    if (!TYPESCRIPT_FENCE.test((match[2] ?? '').trim())) {
      continue
    }
    // +1: the fence's content begins on the line after the opening ```.
    fences.push({ code: match[3] ?? '', line: lineOf(markdown, match.index) + 1 })
  }
  return fences
}

export function extractImports(code: string): ExtractedImport[] {
  const imports: ExtractedImport[] = []
  IMPORT_STATEMENT.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMPORT_STATEMENT.exec(code))) {
    imports.push({
      specifier: match[2] ?? '',
      statement: match[0],
      line: lineOf(code, match.index),
    })
  }
  return imports
}

/**
 * On a fence that parses with no recovered errors the AST's import list is
 * authoritative; a disagreement means the extractor is blind to an import shape,
 * which is a gate failure rather than a missing finding.
 */
function crossCheckExtraction(code: string, extracted: readonly ExtractedImport[]): string | null {
  let body: Statement[]
  try {
    const result = parse(code, {
      sourceType: 'module',
      errorRecovery: true,
      plugins: [...BABEL_PLUGINS],
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
    })
    // `errors` is nullable in the type; a null one is not evidence of a clean
    // parse, so treat it the same as a recovered error and stand down.
    if (result.errors === null || result.errors.length > 0) {
      return null
    }
    body = result.program.body
  } catch {
    return null
  }

  const fromAst = body.flatMap((statement) =>
    statement.type === 'ImportDeclaration' ? [statement.source.value] : [],
  )
  const fromText = extracted.map((entry) => entry.specifier)
  if (fromAst.join('\n') === fromText.join('\n')) {
    return null
  }
  return `the textual import scan read [${fromText.join(', ')}] where the parser read [${fromAst.join(', ')}]`
}

/** Named bindings an import statement pulls in. Namespace imports bind none. */
function importedNames(statement: string): string[] {
  const body = parseModule(statement, 'an import statement in a docs snippet')
  const names: string[] = []
  for (const node of body) {
    if (node.type !== 'ImportDeclaration') {
      continue
    }
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        const imported = specifier.imported
        names.push(imported.type === 'Identifier' ? imported.name : imported.value)
      } else if (specifier.type === 'ImportDefaultSpecifier') {
        names.push('default')
      }
    }
  }
  return names
}

/**
 * `@guren/core` leads when it qualifies, being the documented path; the rest
 * sort by specifier length then alphabetically, roots ahead of their subpaths.
 */
function orderExporters(specifiers: string[]): string[] {
  return [...specifiers].sort((a, b) => {
    if (a === '@guren/core') return -1
    if (b === '@guren/core') return 1
    return a.length - b.length || a.localeCompare(b)
  })
}

async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

export async function auditDocsImportSources(root: string, docsDir = 'docs'): Promise<DocsImportReport> {
  const entryPoints = await collectEntryPoints(root)
  const resolver = new SurfaceResolver(entryPoints)

  // Reverse index over every first-party entry point, plugins included, which is
  // the only reason `mcpPlugin` traces back to `@guren/plugin-mcp`.
  const exportedFrom = new Map<string, string[]>()
  const openEntryPoints: string[] = []
  const unresolvable: UnresolvableImport[] = []

  for (const specifier of [...entryPoints.keys()].sort()) {
    const entryPoint = entryPoints.get(specifier)
    if (!entryPoint || entryPoint.kind === 'asset') {
      continue
    }
    // Fails on its own account: waiting for a doc to import it would leave the
    // derivation quietly half-blind.
    if (entryPoint.kind === 'unresolved') {
      unresolvable.push({
        location: relative(root, join(entryPoint.packageDir, 'package.json')),
        specifier,
        reason: `exports map declares '${entryPoint.target}', but no matching source exists under src/ — the export surface cannot be derived`,
      })
      continue
    }
    const surface = await resolver.forSpecifier(specifier)
    if (!surface) {
      continue
    }
    if (surface.openedBy) {
      openEntryPoints.push(`${specifier} (re-exports '${surface.openedBy}')`)
    }
    for (const name of surface.names) {
      const owners = exportedFrom.get(name)
      if (owners) {
        owners.push(specifier)
      } else {
        exportedFrom.set(name, [specifier])
      }
    }
  }

  const unexported: UnexportedSymbol[] = []
  let fencesScanned = 0
  let importsChecked = 0
  let symbolsChecked = 0

  // `resolve` rather than `join` so a caller may hand over an absolute tree.
  for (const file of await markdownFiles(resolve(root, docsDir))) {
    const markdown = await readFile(file, 'utf8')
    // Repo-relative for the real tree; a docs dir outside the root (tests hand
    // over a temp one) keeps its absolute path rather than a run of `../`.
    const fromRoot = relative(root, file)
    const displayPath = fromRoot.startsWith('..') ? file : fromRoot

    for (const fence of typescriptFences(markdown)) {
      fencesScanned += 1
      const extracted = extractImports(fence.code)

      const drift = crossCheckExtraction(fence.code, extracted)
      if (drift) {
        unresolvable.push({
          location: `${displayPath}:${fence.line}`,
          specifier: '(fence)',
          reason: `import extraction disagrees with the parser — ${drift}`,
        })
      }

      for (const entry of extracted) {
        if (!entry.specifier.startsWith(FIRST_PARTY_SCOPE)) {
          continue
        }
        const location = `${displayPath}:${fence.line + entry.line - 1}`
        importsChecked += 1

        let names: string[]
        try {
          names = importedNames(entry.statement)
        } catch (error) {
          unresolvable.push({
            location,
            specifier: entry.specifier,
            reason: `import statement does not parse: ${(error as Error).message}`,
          })
          continue
        }
        // The specifier is resolved for every import: a namespace or bare import
        // names no symbols but must still hit an existing package and subpath.
        // The one exemption is an asset subpath, which has no surface to read
        // but must still be declared in the exports map.
        if (names.length === 0 && entryPoints.get(entry.specifier)?.kind === 'asset') {
          continue
        }

        let surface: Surface | null
        try {
          surface = await resolver.forSpecifier(entry.specifier)
        } catch (error) {
          unresolvable.push({ location, specifier: entry.specifier, reason: (error as Error).message })
          continue
        }
        if (!surface) {
          unresolvable.push({
            location,
            specifier: entry.specifier,
            reason: entryPoints.has(entry.specifier.split('/').slice(0, 2).join('/'))
              ? 'no such subpath in the package\'s exports map — Node would refuse this import'
              : 'no such first-party package in this workspace',
          })
          continue
        }
        // An open surface cannot prove absence; `openEntryPoints` reports it.
        if (surface.openedBy) {
          continue
        }

        for (const name of names) {
          symbolsChecked += 1
          if (surface.names.has(name)) {
            continue
          }
          unexported.push({
            location,
            symbol: name,
            specifier: entry.specifier,
            exportedBy: orderExporters(exportedFrom.get(name) ?? []),
          })
        }
      }
    }
  }

  return {
    unexported,
    unresolvable,
    openEntryPoints,
    fencesScanned,
    importsChecked,
    symbolsChecked,
  }
}

export function formatReport(report: DocsImportReport): string {
  const lines: string[] = []

  if (report.unresolvable.length > 0) {
    lines.push('Docs import audit could not resolve:')
    for (const item of report.unresolvable) {
      lines.push(`- ${item.location}: '${item.specifier}' — ${item.reason}`)
    }
    lines.push('')
  }

  if (report.unexported.length > 0) {
    lines.push('Docs import audit found imports of symbols their specifier does not export:')
    for (const item of report.unexported) {
      const owners = item.exportedBy
      let hint: string
      if (owners.length === 0) {
        hint = 'no first-party entry point exports it — the symbol does not exist yet, or the name is wrong'
      } else if (owners.every((owner) => owner.startsWith('@guren/server'))) {
        // Swapping the specifier here trades this failure for a core-first one.
        hint = `only ${owners.join(', ')} exports it, which docs may not name (audit:core-first) — widen @guren/core's barrel or document a different API`
      } else {
        hint = `exported by ${owners.join(', ')}`
      }
      lines.push(`- ${item.location}: \`${item.symbol}\` is not exported by '${item.specifier}' — ${hint}`)
    }
  }

  return lines.join('\n')
}
