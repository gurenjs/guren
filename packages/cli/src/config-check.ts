/**
 * Config wiring checks (RFC 0027 §6). A `config/<key>.ts` definition no config array
 * lists binds nothing, which looks exactly like a configured app until the first
 * request; a listed file that is not a definition fails the boot. The arrays are the
 * entry's `createApp({ config })` and, for a module `createApp({ modules })` lists,
 * its `defineModule({ config })` (RFC 0002). An array this cannot read whole is no
 * evidence either way, and reports nothing.
 */
import { resolve } from 'node:path'
import type { Node, ObjectExpression } from '@babel/types'
import { objectLiteral, propertyValue, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { check, type CheckResult } from './check-result'
import { findFirstExisting, listAppRoots, toPosixRelative } from './discovery'
import type { ParseCache } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'
import { loadResolvedConfig, type ResolvedConfigEntry } from './resolved-config'
import { importsByLocal, specifierBase, withoutExtension } from './schema-binding'

/** The literal `createApp({ … })` takes, or `null` when the entry passes anything else. */
export function createAppOptions(program: unknown): ObjectExpression | null {
  return calleeOptions(program, 'createApp')
}

function calleeOptions(program: unknown, callee: string): ObjectExpression | null {
  let options: ObjectExpression | null = null
  walk(program, (node) => {
    if (options) return false
    if (node.type !== 'CallExpression') return
    const target = node.callee as BabelNode | undefined
    // Assignment-shape independent: every shipped entry writes `const app = createApp({…})`.
    if (target?.type !== 'Identifier' || target.name !== callee) return
    options = objectLiteral((node.arguments as Node[])[0])
    return false
  })
  return options
}

/**
 * Each element of an array option traced to the file its identifier is imported
 * from, absolute and without extension; `null` for an element this cannot trace.
 * `undefined` when the value is not an array literal.
 */
function importedArrayFiles(
  declared: Node,
  program: { body: unknown[] },
  cwd: string,
  fromFile: string,
): Array<string | null> | undefined {
  const array = unwrapTypeAssertion(declared)
  if (array.type !== 'ArrayExpression') return undefined

  const imports = importsByLocal(program.body as never)
  return array.elements.map((element) => {
    const value = element ? unwrapTypeAssertion(element as Node) : null
    const source = value?.type === 'Identifier' ? imports.get(value.name)?.source : undefined
    const base = source === undefined ? null : specifierBase(cwd, fromFile, source)
    return base === null ? null : withoutExtension(base)
  })
}

/**
 * What `createApp({ modules })` lists (the one reading of it): each element's file,
 * absolute and without extension, or `null` for one this cannot trace. `absent` when
 * the option is missing, `not-array` when it is not an array literal.
 */
export function createAppModuleFiles(
  options: ObjectExpression,
  program: { body: unknown[] },
  cwd: string,
  entryFile: string,
): Array<string | null> | 'absent' | 'not-array' {
  const declared = propertyValue(options, 'modules')
  if (declared === undefined) return 'absent'
  return importedArrayFiles(declared, program, cwd, entryFile) ?? 'not-array'
}

/** Whether a traced `modules` element is `modules/<name>` or its `index`. */
export function namesModuleDir(file: string, moduleDir: string): boolean {
  return file === moduleDir || file === resolve(moduleDir, 'index')
}

/** A config array's files, app-relative and without extension; `null` when it cannot be read whole. */
function configArrayFiles(declared: Node, program: { body: unknown[] }, cwd: string, fromFile: string): string[] | null {
  const files = importedArrayFiles(declared, program, cwd, fromFile)
  // One element this cannot name would make every other verdict a guess.
  if (!files || files.includes(null)) return null
  return (files as string[]).map((file) => toPosixRelative(cwd, file))
}

interface Lister {
  /** `createApp({ config }) in src/app.ts`, or `defineModule({ config }) in modules/<name>/index.ts`. */
  readonly label: string
  /** The file whose array lists it. */
  readonly file: string
  /** Set on a module `createApp({ modules })` does not list, whose array nothing reads. */
  readonly unmountedModule?: string
}

interface Listing {
  readonly file: string
  readonly lister: Lister
}

/** Every config array the app holds, or `null` when one of them cannot be read whole. */
async function readListings(cwd: string, cache: ParseCache, entryPath: string): Promise<Listing[] | null> {
  const entryFile = resolve(cwd, entryPath)
  const parsed = await cache.get(entryFile)
  const options = parsed ? createAppOptions(parsed.ast.program) : null
  if (!parsed || !options) return null

  const listings: Listing[] = []
  const rootLister: Lister = { label: `createApp({ config }) in ${entryPath}`, file: entryPath }
  // No `config` option wires nothing, which is the finding itself.
  const rootConfig = propertyValue(options, 'config')
  if (rootConfig !== undefined) {
    const files = configArrayFiles(rootConfig, parsed.ast.program, cwd, entryFile)
    if (files === null) return null
    listings.push(...files.map((file) => ({ file, lister: rootLister })))
  }

  let mounted: Array<string | null> | 'absent' | 'not-array' | undefined
  for (const root of await listAppRoots(cwd)) {
    if (root.module === null) continue
    const moduleDir = toPosixRelative(cwd, root.dir)
    const descriptor = await findFirstExisting(cwd, [`${moduleDir}/index.ts`, `${moduleDir}/index.js`])
    // No descriptor, no module to mount. One that is not a readable `defineModule({…})`
    // may still carry a `config` naming any file, so nothing is judged.
    if (descriptor === null) continue
    const descriptorAst = await cache.get(resolve(cwd, descriptor))
    const moduleOptions = descriptorAst ? calleeOptions(descriptorAst.ast.program, 'defineModule') : null
    if (!descriptorAst || !moduleOptions) return null

    const declared = propertyValue(moduleOptions, 'config')
    if (declared === undefined) {
      // A spread may carry `config`, as it may `routes` in routes-check.
      if (moduleOptions.properties.some((property) => property.type === 'SpreadElement')) return null
      continue
    }
    const files = configArrayFiles(declared, descriptorAst.ast.program, cwd, resolve(cwd, descriptor))
    if (files === null) return null
    if (files.length === 0) continue

    mounted ??= createAppModuleFiles(options, parsed.ast.program, cwd, entryFile)
    if (mounted === 'not-array' || (mounted !== 'absent' && mounted.includes(null))) return null
    const isMounted = mounted !== 'absent' && mounted.some((file) => file !== null && namesModuleDir(file, root.dir))
    const lister: Lister = {
      label: `defineModule({ config }) in ${descriptor}`,
      file: descriptor,
      ...(isMounted ? {} : { unmountedModule: moduleDir }),
    }
    listings.push(...files.map((file) => ({ file, lister })))
  }
  return listings
}

/** Where a file that no array lists belongs: its own module's descriptor, or the entry. */
function wiringTarget(file: string, entryPath: string): string {
  const module = /^modules\/([^/]+)\/config\//u.exec(file)?.[1]
  return module === undefined
    ? `createApp({ config: [...] }) in ${entryPath}`
    : `defineModule({ config: [...] }) in modules/${module}/index.ts`
}

/** Only a file an array lists can fail; everything else is a warning or nothing at all. */
function judge(entry: ResolvedConfigEntry, listers: Lister[], entryPath: string): CheckResult | null {
  const title = 'Config wiring'
  const read = listers.filter((lister) => lister.unmountedModule === undefined)
  if (read.length === 0) {
    if (entry.problem) return null
    const unmounted = listers[0]
    return check(
      `config-unwired:${entry.file}`,
      title,
      'warn',
      unmounted
        ? `${entry.file} declares the "${entry.key}" config, and ${unmounted.label} lists it, but createApp({ modules }) in ${entryPath} does not list ${unmounted.unmountedModule}. Nothing reads it, so the defaults apply instead.`
        : entry.file.startsWith('modules/')
          ? `${entry.file} declares the "${entry.key}" config, but neither its module's defineModule({ config }) nor createApp({ config }) in ${entryPath} lists it. Nothing reads it, so the defaults apply instead.`
          : `${entry.file} declares the "${entry.key}" config, but ${entryPath} does not list it in createApp({ config }). Nothing reads it, so the defaults apply instead.`,
      unmounted
        ? `Add the module to createApp({ modules: [...] }) in ${entryPath}.`
        : `Add it to ${wiringTarget(entry.file, entryPath)}.`,
      entry.file,
    )
  }

  if (entry.problem === 'not-a-definition') {
    return check(
      `config-not-a-definition:${entry.file}`,
      title,
      'fail',
      `${read[0]!.label} lists ${entry.file}, but it ${entry.detail}. The boot fails on it.`,
      `Default-export a definition from ${entry.file} (defineSessionConfig, defineCacheConfig, …), or drop it from the array.`,
      entry.file,
    )
  }
  if (entry.problem === 'import-failed' || entry.problem === 'resolve-threw') {
    return check(
      `config-unreadable:${entry.file}`,
      title,
      'warn',
      `${entry.file} ${entry.detail}, so its wiring was not checked. The boot runs the same code.`,
      undefined,
      entry.file,
    )
  }
  // `unverified-env` is the machine's environment, not the app's wiring.
  return null
}

/** The boot refuses a key two read arrays define (`ConfigServiceProvider`), so this reports it first. */
function judgeDistinctKeys(entries: ReadonlyArray<ResolvedConfigEntry>, listersOf: (entry: ResolvedConfigEntry) => Lister[]): CheckResult[] {
  const byKey = new Map<string, Array<{ file: string; lister: Lister }>>()
  for (const entry of entries) {
    // Only these two carry the file's name in place of the definition's key.
    if (entry.problem === 'import-failed' || entry.problem === 'not-a-definition') continue
    for (const lister of listersOf(entry)) {
      if (lister.unmountedModule !== undefined) continue
      byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), { file: entry.file, lister }])
    }
  }
  return [...byKey].filter(([, listed]) => listed.length > 1).map(([key, listed]) =>
    check(
      `config-duplicate-key:${key}`,
      'Config wiring',
      'fail',
      `The "${key}" config is listed ${listed.length} times: ${listed.map(({ file, lister }) => `${file} by ${lister.label}`).join(', ')}. The boot fails on the second.`,
      'Keep one definition per key across createApp({ config }) and every module\'s defineModule({ config }).',
      listed[1]!.file,
    ),
  )
}

export async function checkConfigWiring(options: { cwd: string; cache: ParseCache }): Promise<CheckResult[]> {
  const { cwd, cache } = options

  // Before the import: an app this cannot judge should not have its config/ executed.
  const entryPath = await resolveAppEntry(cwd)
  const listings = entryPath === null ? null : await readListings(cwd, cache, entryPath)
  if (listings === null || entryPath === null) return []

  // A file is listed by its own name or, for a directory import, its index.
  const listersOf = (entry: ResolvedConfigEntry): Lister[] => {
    const file = entry.file.replace(/\.[jt]s$/u, '')
    return listings.filter((listing) => listing.file === file || `${listing.file}/index` === file).map((listing) => listing.lister)
  }
  // An unmounted module's array is never read, so it does not earn a file an import.
  const read = listings.filter(({ lister }) => lister.unmountedModule === undefined)
  const listed = new Set(read.flatMap(({ file }) => [`${file}.ts`, `${file}/index.ts`]))
  const resolved = await loadResolvedConfig(cwd, listed)
  const results = resolved.entries.flatMap((entry) => {
    const result = judge(entry, listersOf(entry), entryPath)
    return result ? [result] : []
  })

  const wired = resolved.entries.filter((entry) => !entry.problem && listersOf(entry).some((lister) => lister.unmountedModule === undefined))
  if (wired.length === 0) return results

  const moduleListers = new Set(wired.flatMap((entry) => listersOf(entry)).filter((lister) => lister.file !== entryPath).map((lister) => lister.file))
  const summary = moduleListers.size === 0
    ? `${entryPath} lists ${wired.length} config definition(s) in createApp({ config }).`
    : `${wired.length} config definition(s) are listed across ${entryPath} and ${[...moduleListers].sort().join(', ')}.`
  return [check('config-wired', 'Config wiring', 'pass', summary), ...results, ...judgeDistinctKeys(resolved.entries, listersOf)]
}
