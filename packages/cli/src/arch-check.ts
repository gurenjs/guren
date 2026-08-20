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

  // Both evaluators scan the same set — every importable file in the project —
  // so the walk is shared. Lazy because a project with neither `modules/` nor
  // a guren.arch.ts reaches neither scan, and must not pay for a walk nothing
  // reads. `readonly` because the two now share one array instance.
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
 * Zero-config module boundary rules (RFC 0002 "Derived boundary rules"),
 * active whenever a `modules/` directory exists — no `guren.arch.ts`
 * required. Two rules, neither user-authorable (the frozen public rule
 * vocabulary deliberately has no allow-list primitive; these exist only to
 * make the zero-config default usable):
 *
 * 1. A file inside `modules/<a>/` may not import from `modules/<b>/`,
 *    except that module's public surface.
 * 2. Top-level application code may import a module's public surface but
 *    not its internals.
 *
 * **Amended from the RFC's original text:** a module's public surface is
 * not just `index.ts` — `db/schema.ts` is exempt too, since `make:module`
 * itself wires the project's root `db/schema.ts` to
 * `export * from '../modules/<name>/db/schema'`, which the RFC's literal
 * "except index.ts" wording would otherwise flag as a violation of its own
 * generator's output.
 *
 * Always runtime imports only: these rules take no options, so a set-wide
 * `includeTypeImports` in `guren.arch.ts` deliberately does not reach them
 * — the `ArchRuleSet` JSDoc and the CLI guide both say so.
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

  // The effective flag is a property of the rule set, constant for the run —
  // resolved once here so no later call site re-derives the
  // `rule ?? set ?? false` cascade and drifts.
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

    // Type-only specifiers are only extracted (and the type-position walk
    // only paid for) when some applicable rule will actually judge them.
    const wantsTypes = applicableRules.some(ruleIncludesTypes)

    const specifiers = extractImportSpecifiers(parsed.ast.program.body, wantsTypes)
    if (specifiers.length === 0) continue

    filesChecked += 1
    const resolvedImports = dedupeResolvedImports(
      await Promise.all(
        specifiers.map(async (entry) => ({
          ...(await resolveImportSpecifier(cwd, absPath, entry.specifier, entry.typeOnly)),
          typeOnly: entry.typeOnly,
        })),
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
          `${relPath} ${imp.typeOnly ? 'imports (type-only)' : 'imports'} '${imp.specifier}', which could not be resolved to a project file.`,
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
        // naming the kind in the message keeps an includeTypeImports finding
        // explainable: the file shows no runtime import to point at
        const importVerb = imp.typeOnly ? 'imports (type-only)' : 'imports'

        if (imp.kind === 'package') {
          if (disallowedPackages.has(imp.packageName)) {
            results.push(
              check(
                `arch:${relPath}:${imp.specifier}:pkg`,
                'Architecture boundary',
                severity,
                `${relPath} (${fromLabel}) ${importVerb} disallowed package '${imp.packageName}'.`,
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
                `${relPath} (${fromLabel}) ${importVerb} '${imp.specifier}', which is in the disallowed layer '${violatedTarget}'.`,
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
 * `entry` is either a declared layer name (matched via that layer's globs)
 * or an inline glob matched directly — the `from`/`disallow` fields of an
 * `ArchRule` accept both per the RFC's "layer name (or inline glob)" contract.
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

type ResolvedImport =
  | { specifier: string; kind: 'package'; packageName: string }
  | { specifier: string; kind: 'file'; fileRelPath: string }
  | { specifier: string; kind: 'unresolved' }

/**
 * One entry per resolved target, runtime beating type-only: a file that
 * imports a module for real and also names it in a type position has one
 * boundary crossing, and it is a runtime one. Keyed on the *resolved*
 * identity, not the specifier — `'./Post.js'` and `'./Post'` are two
 * spellings of one file, and keying on the string would let a type-only
 * duplicate survive next to its runtime twin.
 */
function dedupeResolvedImports(
  imports: Array<ResolvedImport & { typeOnly: boolean }>,
): Array<ResolvedImport & { typeOnly: boolean }> {
  const byTarget = new Map<string, ResolvedImport & { typeOnly: boolean }>()
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
    return { specifier, kind: 'package', packageName: packageNameFromSpecifier(specifier) }
  }

  const rawTarget = specifier.startsWith('@/')
    ? resolve(cwd, specifier.slice(2))
    : resolve(dirname(importerAbsPath), specifier)

  // TS source under NodeNext/bundler resolution commonly writes
  // `import './Post.js'` for a file that's actually `Post.ts` on disk — strip
  // a known extension before re-appending candidates, so `Post.js` resolves
  // to `Post.ts` instead of a literal (nonexistent) `Post.js`.
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
    // A declaration file can satisfy only a type-only import, so the
    // candidates exist only on that path — for a runtime import a lone
    // `.d.ts` on disk really is unresolved.
    ...(typeOnly ? [`${base}.d.ts`, join(base, 'index.d.ts')] : []),
  ]

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return { specifier, kind: 'file', fileRelPath: toPosixRelative(cwd, candidate) }
    }
  }

  return { specifier, kind: 'unresolved' }
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
  /**
   * The import compiles away entirely: a whole-declaration `import type` /
   * `export type ... from`, or an `import('...')` in a type position. Rules
   * skip these unless `includeTypeImports` says otherwise.
   */
  typeOnly: boolean
}

/**
 * Top-level `import ... from '...'` and `export ... from '...'` specifiers.
 * Dynamic `import()` *expressions* are intentionally not followed (scope
 * frozen by RFC 0002 — "static import / export ... from specifiers").
 *
 * Whole-declaration type-only imports/exports (`import type { X } from
 * '...'`, `export type { X } from '...'`) are marked `typeOnly` — they
 * compile away entirely, so they create no runtime coupling across a
 * boundary. Sharing a type (a DTO, a props interface) across layers is a
 * common, benign pattern; flagging it by default would be exactly the kind
 * of plausible-but-wrong violation the severity policy above exists to
 * avoid. A *mixed* declaration (`import { type X, Y } from '...'`) counts
 * as runtime — some binding in it (`Y`) is a real runtime import, so the
 * boundary crossing is real regardless of `X`.
 *
 * With `includeTypeOnly`, type-only specifiers are returned too, and the
 * whole AST is additionally walked for `import('...')` in type positions
 * (`TSImportType`) — the one specifier form that lives outside the
 * top-level statements. Only files where some applicable rule opted into
 * type imports pay for that walk.
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
    // `import('...').X` in a type position is the one specifier form living
    // outside the top-level statements, so it needs the shared AST walker.
    walk(body, (node) => {
      if (node.type !== 'TSImportType') return
      const spec = literalString(node.argument)
      if (spec !== null) specifiers.push({ specifier: spec, typeOnly: true })
    })
  }

  return specifiers
}
