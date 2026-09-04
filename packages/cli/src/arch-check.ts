import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Statement } from '@babel/types'
import { check, type CheckResult, type CheckStatus } from './check-result'
import {
  collectFiles,
  toPosixRelative,
  listModuleNames,
  moduleNameFromRelPath,
  NON_SOURCE_DIR_NAMES,
  IMPORTABLE_EXTENSIONS,
} from './discovery'
import { matchesAnyGlob } from './glob-match'
import { literalString, walk } from './ast-walk'
import { loadArchConfig } from './arch-config'
import type { ArchLayers, ArchRule, ArchRuleSet } from './arch/index'
import type { ParseCache } from './parse-cache'

export interface RunArchCheckOptions {
  cwd: string
  cache: ParseCache
  /** Project-relative POSIX paths; when set, only these files are scanned. */
  changedFiles?: Set<string> | null
}

/**
 * Runs architecture boundary checks: `guren.arch.ts` rules (opt-in — no
 * results when the file is absent) plus module-derived zero-config rules
 * (opt-in via the presence of a `modules/` directory instead). The two are
 * independent and composed together, never one replacing the other.
 */
export async function runArchCheck(options: RunArchCheckOptions): Promise<CheckResult[]> {
  const { cwd, cache, changedFiles } = options
  const loaded = await loadArchConfig(cwd)

  if (loaded.loadError) {
    return [
      check(
        'arch:config',
        'Architecture rules',
        'warn',
        loaded.loadError,
        'Fix guren.arch.ts and re-run `guren check`.',
      ),
    ]
  }

  // One shared walk. Lazy so a project with neither `modules/` nor a
  // guren.arch.ts pays for nothing; `readonly` because both evaluators share it.
  let importableFilesPromise: Promise<readonly string[]> | null = null
  const importableFiles = (): Promise<readonly string[]> =>
    (importableFilesPromise ??= collectFiles(cwd, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES))

  const derivedResults = await evaluateDerivedModuleRules(cwd, cache, changedFiles, importableFiles)
  const explicitResults = loaded.config
    ? await evaluateArchRules(cwd, cache, loaded.config, changedFiles, importableFiles)
    : []

  return [...derivedResults, ...explicitResults]
}

/**
 * Zero-config module boundary rules (RFC 0002), active whenever a `modules/`
 * directory exists: nothing outside a module may reach past its public surface.
 * Amended from the RFC's literal "except index.ts" — `db/schema.ts` is exempt
 * too, since `make:module` wires the root schema to it. Runtime imports only: a
 * set-wide `includeTypeImports` deliberately does not reach these.
 */
async function evaluateDerivedModuleRules(
  cwd: string,
  cache: ParseCache,
  changedFiles: Set<string> | null | undefined,
  importableFiles: () => Promise<readonly string[]>,
): Promise<CheckResult[]> {
  const moduleNames = await listModuleNames(cwd)
  if (moduleNames.length === 0) return []

  const results: CheckResult[] = []
  const files = await importableFiles()
  let filesChecked = 0

  for (const absPath of files) {
    const relPath = toPosixRelative(cwd, absPath)
    if (changedFiles && !changedFiles.has(relPath)) continue

    const parsed = await cache.get(absPath)
    if (!parsed) continue

    const specifiers = extractImportSpecifiers(parsed.ast.program.body)
    if (specifiers.length === 0) continue

    filesChecked += 1
    const resolvedImports = await Promise.all(
      specifiers.map((entry) => resolveImportSpecifier(cwd, absPath, entry.specifier)),
    )
    const importerModule = moduleNameFromRelPath(relPath)

    for (const imp of resolvedImports) {
      if (imp.kind !== 'file') continue

      const targetModule = moduleNameFromRelPath(imp.fileRelPath)
      if (!targetModule || targetModule === importerModule) continue
      if (isModulePublicSurface(imp.fileRelPath, targetModule)) continue

      results.push(
        check(
          `arch:module-boundary:${relPath}:${imp.specifier}`,
          'Module boundary',
          'fail',
          `${relPath} imports '${imp.specifier}', reaching into modules/${targetModule}'s internals.`,
          `Import from modules/${targetModule} (its index.ts) or move the shared code into the module's public API.`,
          relPath,
        ),
      )
    }
  }

  if (results.length === 0) {
    results.push(
      check(
        'arch:module-summary',
        'Module boundaries',
        'pass',
        `Checked ${filesChecked} file(s) across ${moduleNames.length} module(s) — no boundary violations.`,
      ),
    )
  }

  return results
}

function isModulePublicSurface(relPath: string, moduleName: string): boolean {
  return relPath === `modules/${moduleName}/index.ts` || relPath === `modules/${moduleName}/db/schema.ts`
}

async function evaluateArchRules(
  cwd: string,
  cache: ParseCache,
  config: ArchRuleSet,
  changedFiles: Set<string> | null | undefined,
  importableFiles: () => Promise<readonly string[]>,
): Promise<CheckResult[]> {
  const layers = config.layers ?? {}
  const rules = config.rules
  const results: CheckResult[] = []

  // Resolved once so no later call site re-derives the `rule ?? set ?? false` cascade.
  const ruleIncludesTypes = (rule: ArchRule): boolean =>
    rule.includeTypeImports ?? config.includeTypeImports ?? false

  const files = await importableFiles()
  let filesChecked = 0

  for (const absPath of files) {
    const relPath = toPosixRelative(cwd, absPath)
    if (changedFiles && !changedFiles.has(relPath)) continue

    const applicableRules = rules.filter((rule) => matchesLayerOrGlob(relPath, rule.from, layers))
    if (applicableRules.length === 0) continue

    const parsed = await cache.get(absPath)
    if (!parsed) continue

    // The type-position walk is paid for only when a rule will judge its results.
    const wantsTypes = applicableRules.some(ruleIncludesTypes)

    const specifiers = extractImportSpecifiers(parsed.ast.program.body, wantsTypes)
    if (specifiers.length === 0) continue

    filesChecked += 1
    const resolvedImports = dedupeResolvedImports(
      await Promise.all(
        specifiers.map((entry) => resolveImportSpecifier(cwd, absPath, entry.specifier, entry.typeOnly)),
      ),
    )
    const fromLabel = classifyLayer(relPath, layers) ?? relPath

    for (const imp of resolvedImports) {
      if (imp.kind !== 'unresolved') continue
      results.push(
        check(
          `arch:unresolved:${relPath}:${imp.specifier}`,
          'Architecture boundary',
          'warn',
          `${relPath} ${importVerb(imp)} '${imp.specifier}', which could not be resolved to a project file.`,
          undefined,
          relPath,
        ),
      )
    }

    for (const rule of applicableRules) {
      const disallowedTargets = normalizeToArray(rule.disallow)
      const disallowedPackages = new Set(normalizeToArray(rule.disallowPackages))
      const severity: CheckStatus = rule.severity ?? 'fail'
      const includeTypes = ruleIncludesTypes(rule)

      for (const imp of resolvedImports) {
        if (imp.typeOnly && !includeTypes) continue

        if (imp.kind === 'package') {
          if (disallowedPackages.has(imp.packageName)) {
            results.push(
              check(
                `arch:${relPath}:${imp.specifier}:pkg`,
                'Architecture boundary',
                severity,
                `${relPath} (${fromLabel}) ${importVerb(imp)} disallowed package '${imp.packageName}'.`,
                rule.message ?? `Avoid importing '${imp.packageName}' directly from '${fromLabel}'.`,
                relPath,
              ),
            )
          }
          continue
        }

        if (imp.kind === 'file') {
          const violatedTarget = disallowedTargets.find((entry) =>
            matchesLayerOrGlob(imp.fileRelPath, entry, layers),
          )
          if (violatedTarget) {
            results.push(
              check(
                `arch:${relPath}:${imp.specifier}:${violatedTarget}`,
                'Architecture boundary',
                severity,
                `${relPath} (${fromLabel}) ${importVerb(imp)} '${imp.specifier}', which is in the disallowed layer '${violatedTarget}'.`,
                rule.message ?? `Files in '${fromLabel}' must not import from '${violatedTarget}'.`,
                relPath,
              ),
            )
          }
        }
      }
    }
  }

  if (results.length === 0) {
    results.push(
      check(
        'arch:summary',
        'Architecture rules',
        'pass',
        `Checked ${filesChecked} file(s) across ${Object.keys(layers).length} layer(s), ${rules.length} rule(s) — no violations.`,
      ),
    )
  }

  return results
}

/**
 * `entry` is a declared layer name or an inline glob: `from`/`disallow` accept
 * both, per the RFC's "layer name (or inline glob)" contract.
 */
function matchesLayerOrGlob(relPath: string, entry: string, layers: ArchLayers): boolean {
  if (Object.prototype.hasOwnProperty.call(layers, entry)) {
    return matchesAnyGlob(relPath, layers[entry])
  }
  return matchesAnyGlob(relPath, entry)
}

/** Named layer this path belongs to, for message text. Declaration order wins on overlap. */
function classifyLayer(relPath: string, layers: ArchLayers): string | null {
  for (const [name, globs] of Object.entries(layers)) {
    if (matchesAnyGlob(relPath, globs)) return name
  }
  return null
}

function normalizeToArray(value: string | string[] | undefined): string[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

type ResolvedImport = { specifier: string; typeOnly: boolean } & (
  | { kind: 'package'; packageName: string }
  | { kind: 'file'; fileRelPath: string }
  | { kind: 'unresolved' }
)

/**
 * Naming the kind keeps an includeTypeImports finding explainable: the file
 * shows no runtime import to point at.
 */
function importVerb(imp: { typeOnly: boolean }): string {
  return imp.typeOnly ? 'imports (type-only)' : 'imports'
}

/**
 * One entry per resolved target, runtime beating type-only. Keyed on the
 * resolved identity, not the specifier: `'./Post.js'` and `'./Post'` are two
 * spellings of one file, so a string key would keep a type-only duplicate.
 */
function dedupeResolvedImports(imports: ResolvedImport[]): ResolvedImport[] {
  if (imports.length < 2) return imports
  const byTarget = new Map<string, ResolvedImport>()
  for (const imp of imports) {
    const key =
      imp.kind === 'file' ? `file:${imp.fileRelPath}`
      : imp.kind === 'package' ? `pkg:${imp.packageName}`
      : `unresolved:${imp.specifier}`
    const existing = byTarget.get(key)
    if (!existing || (existing.typeOnly && !imp.typeOnly)) {
      byTarget.set(key, imp)
    }
  }
  return [...byTarget.values()]
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('@/')
}

function packageNameFromSpecifier(specifier: string): string {
  const segments = specifier.split('/')
  if (specifier.startsWith('@')) return segments.slice(0, 2).join('/')
  return segments[0]!
}

async function resolveImportSpecifier(
  cwd: string,
  importerAbsPath: string,
  specifier: string,
  typeOnly = false,
): Promise<ResolvedImport> {
  if (isBareSpecifier(specifier)) {
    return { specifier, typeOnly, kind: 'package', packageName: packageNameFromSpecifier(specifier) }
  }

  const rawTarget = specifier.startsWith('@/')
    ? resolve(cwd, specifier.slice(2))
    : resolve(dirname(importerAbsPath), specifier)

  // TS source under NodeNext writes `import './Post.js'` for a file that is
  // `Post.ts` on disk, so the extension is stripped before candidates are tried.
  const base = stripKnownExtension(rawTarget)

  const candidates = [
    rawTarget,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.js'),
  ]
  if (typeOnly) {
    // A declaration file can satisfy only a type-only import — for a runtime
    // import a lone `.d.ts` on disk really is unresolved.
    candidates.push(`${base}.d.ts`, join(base, 'index.d.ts'))
  }

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return { specifier, typeOnly, kind: 'file', fileRelPath: toPosixRelative(cwd, candidate) }
    }
  }

  return { specifier, typeOnly, kind: 'unresolved' }
}

const KNOWN_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']

function stripKnownExtension(path: string): string {
  for (const ext of KNOWN_EXTENSIONS) {
    if (path.endsWith(ext)) return path.slice(0, -ext.length)
  }
  return path
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath)
    return true
  } catch {
    return false
  }
}

interface ExtractedSpecifier {
  specifier: string
  /** The import compiles away entirely; rules skip these unless `includeTypeImports` is set. */
  typeOnly: boolean
}

/**
 * Top-level `import ... from` and `export ... from` specifiers; dynamic
 * `import()` expressions are not followed (scope frozen by RFC 0002). A
 * whole-declaration `import type` creates no runtime coupling and is marked
 * `typeOnly`, while a mixed declaration counts as runtime. Under
 * `includeTypeOnly` those return too, plus type-position `import('...')`.
 */
function extractImportSpecifiers(body: Statement[], includeTypeOnly = false): ExtractedSpecifier[] {
  const specifiers: ExtractedSpecifier[] = []

  for (const node of body) {
    if (node.type === 'ImportDeclaration') {
      const typeOnly = node.importKind === 'type'
      if (typeOnly && !includeTypeOnly) continue
      specifiers.push({ specifier: node.source.value, typeOnly })
    } else if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      node.source
    ) {
      const typeOnly = node.exportKind === 'type'
      if (typeOnly && !includeTypeOnly) continue
      specifiers.push({ specifier: node.source.value, typeOnly })
    }
  }

  if (includeTypeOnly) {
    walk(body, (node) => {
      if (node.type !== 'TSImportType') return
      const spec = literalString(node.argument)
      if (spec !== null) specifiers.push({ specifier: spec, typeOnly: true })
    })
  }

  return specifiers
}
