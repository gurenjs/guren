/**
 * The runtime imports of every app source file (RFC 0039 §4): the packages each
 * file imports by a bare specifier and the app files it imports by a relative or
 * `@/` one, a literal `import.meta.glob()` expanded. Type-only imports are skipped.
 * A construct the reader cannot follow (another `import()`, `require()`, `new
 * Worker()`, an import that does not resolve, a file that does not parse) is a
 * coverage reason naming the file, never a file with no imports.
 */
import { posix } from 'node:path'
import type { Expression, Node, Statement } from '@babel/types'
import type { GraphCoverage } from './application-graph'
import { literalString, unwrapTypeAssertion, walk } from './ast-walk'
import { IMPORTABLE_EXTENSIONS, toPosixRelative } from './discovery'
import { isBareSpecifier, packageNameFromSpecifier, resolveImportPath, type FileProbe } from './import-resolution'
import type { ParseCache } from './parse-cache'
import { specifierBase } from './schema-binding'

export interface PackageImport {
  name: string
  specifier: string
  line: number
}

export interface FileImports {
  packages: PackageImport[]
  /** Project-relative POSIX paths of the app files this one imports. */
  files: string[]
}

export interface ImportScan {
  files: Map<string, FileImports>
  reasons: GraphCoverage['reasons']
}

const RUNTIME_PREFIXES = ['node:', 'bun:']

function isRuntimeBuiltin(specifier: string): boolean {
  return specifier === 'bun' || RUNTIME_PREFIXES.some((prefix) => specifier.startsWith(prefix))
}

interface Found {
  specifier: string
  line: number
}

const PAGES_MANIFEST = /(?:^|\/)\.guren\/pages\.gen(?:\.[cm]?[jt]sx?)?$/u

/**
 * The page resolver every scaffolded client entry writes: `import(pageManifest[name]
 * ?? \`./pages/${name}.tsx\`)`. `.guren/pages.gen` lists the files under that same
 * pages directory, so both sides land on what the template's glob matches.
 */
function pageResolverGlob(argument: Expression, manifestNames: ReadonlySet<string>): string | null {
  const node = unwrapTypeAssertion(argument)
  if (node.type !== 'LogicalExpression' || node.operator !== '??') return null
  const left = unwrapTypeAssertion(node.left)
  const right = unwrapTypeAssertion(node.right)
  if (left.type !== 'MemberExpression' || left.object.type !== 'Identifier' || !manifestNames.has(left.object.name)) return null
  if (right.type !== 'TemplateLiteral' || right.expressions.length !== 1) return null
  const [prefix, suffix] = right.quasis.map((quasi) => quasi.value.cooked ?? '')
  return prefix!.startsWith('./') && prefix!.endsWith('/') ? `${prefix}**/*${suffix}` : null
}

function runtimeSpecifiers(body: Statement[], file: string, reasons: GraphCoverage['reasons']): { found: Found[]; globs: string[] } {
  const found: Found[] = []
  const globs: string[] = []
  const manifestNames = new Set(body.flatMap((node) => node.type === 'ImportDeclaration' && PAGES_MANIFEST.test(node.source.value)
    ? node.specifiers.map((specifier) => specifier.local.name)
    : []))
  const unfollowed = (what: string, line: number | undefined) =>
    reasons.push({ code: 'unfollowed-import', message: `${file}:${line ?? 0} ${what}, which this reader does not follow.`, file })

  for (const node of body) {
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      found.push({ specifier: node.source.value, line: node.loc?.start.line ?? 0 })
    } else if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source && node.exportKind !== 'type') {
      found.push({ specifier: node.source.value, line: node.loc?.start.line ?? 0 })
    }
  }

  walk(body, (visited) => {
    const node = visited as unknown as Node
    const line = node.loc?.start.line
    if (node.type === 'ImportExpression' || (node.type === 'CallExpression' && node.callee.type === 'Import')) {
      const argument = (node.type === 'ImportExpression' ? node.source : node.arguments[0]) as Expression | undefined
      const specifier = literalString(argument)
      const glob = specifier === null && argument ? pageResolverGlob(argument, manifestNames) : null
      if (specifier !== null) found.push({ specifier, line: line ?? 0 })
      else if (glob !== null) globs.push(glob)
      else unfollowed('has an import() whose specifier is not a literal', line)
    } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
      unfollowed('calls require()', line)
    } else if (node.type === 'CallExpression' && isImportMetaGlob(node.callee)) {
      const argument = node.arguments[0] ? unwrapTypeAssertion(node.arguments[0] as Expression) : undefined
      const patterns = argument?.type === 'ArrayExpression' ? argument.elements.map((element) => literalString(element)) : [literalString(argument)]
      if (patterns.length > 0 && patterns.every((pattern): pattern is string => pattern !== null && !pattern.startsWith('!'))) globs.push(...patterns)
      else unfollowed('calls import.meta.glob() with a pattern that is not a literal', line)
    } else if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'Worker') {
      unfollowed('starts a Worker', line)
    }
  })

  return { found, globs }
}

function isImportMetaGlob(callee: unknown): boolean {
  const node = unwrapTypeAssertion(callee as Expression)
  return node.type === 'MemberExpression'
    && node.object.type === 'MetaProperty'
    && node.property.type === 'Identifier'
    && node.property.name === 'glob'
}

/** `files` are absolute paths; the scan keys them project-relative. */
export async function scanImports(cwd: string, cache: ParseCache, files: readonly string[], probe: FileProbe): Promise<ImportScan> {
  const scanned = new Map<string, FileImports>()
  const reasons: GraphCoverage['reasons'] = []
  const projectFiles = files.map((absolute) => toPosixRelative(cwd, absolute))
  const scannedFiles = new Set(projectFiles)

  for (const absolute of files) {
    const file = toPosixRelative(cwd, absolute)
    const parsed = await cache.get(absolute)
    if (!parsed) {
      reasons.push({ code: 'unparsed', message: `${file} could not be read or parsed, so its imports are unknown.`, file })
      continue
    }
    const imports: FileImports = { packages: [], files: [] }
    const { found, globs } = runtimeSpecifiers(parsed.ast.program.body, file, reasons)
    for (const pattern of globs) {
      // Vite reads a leading `/` from the project root, anything else from the importer.
      const glob = new Bun.Glob(pattern.startsWith('/') ? pattern.slice(1) : posix.join(posix.dirname(file), pattern))
      const matched = projectFiles.filter((candidate) => candidate !== file && glob.match(candidate))
      if (matched.length === 0) {
        reasons.push({ code: 'unfollowed-import', message: `${file} globs ${pattern}, which matches no file this reader scans.`, file })
      }
      for (const candidate of matched) {
        if (!imports.files.includes(candidate)) imports.files.push(candidate)
      }
    }
    for (const { specifier, line } of found) {
      if (isBareSpecifier(specifier)) {
        if (!isRuntimeBuiltin(specifier)) imports.packages.push({ name: packageNameFromSpecifier(specifier), specifier, line })
        continue
      }
      const base = specifierBase(cwd, absolute, specifier)
      const target = base === null ? null : await resolveImportPath(base, { probe })
      if (target === null) {
        reasons.push({ code: 'unresolved-import', message: `${file}:${line} imports ${specifier}, which does not resolve to a file.`, file })
        continue
      }
      const relative = toPosixRelative(cwd, target)
      // `.guren/` holds generated maps of the app's own files, which are scanned already; a stylesheet or asset imports no package.
      if (!scannedFiles.has(relative) && !relative.startsWith('.guren/') && IMPORTABLE_EXTENSIONS.has(posix.extname(relative))) {
        reasons.push({ code: 'outside-scan', message: `${file}:${line} imports ${relative}, which this reader does not scan, so its imports are unknown.`, file })
      }
      if (!imports.files.includes(relative)) imports.files.push(relative)
    }
    scanned.set(file, imports)
  }

  return { files: scanned, reasons }
}
