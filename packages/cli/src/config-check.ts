/**
 * Config wiring checks (RFC 0027 §6). A `config/<key>.ts` definition no config array
 * lists binds nothing, which looks exactly like a configured app until the first
 * request; a listed file that is not a definition fails the boot. The arrays are the
 * entry's `createApp({ config })` and, for a module `createApp({ modules })` lists,
 * its `defineModule({ config })` (RFC 0002). An array this cannot read whole is no
 * evidence either way, and reports nothing.
 */
import { resolve } from 'node:path'
import type { Node } from '@babel/types'
import { propertyValue } from './ast-walk'
import { createAppOptions, hidesKeys, importedArrayFiles, moduleMountState, readModuleDescriptor, scaffoldedModuleDescriptor } from './app-entry'
import { check, type CheckResult } from './check-result'
import { listAppRoots, moduleNameFromRelPath, toPosixRelative } from './discovery'
import type { ParseCache } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'
import { loadResolvedConfig, type ResolvedConfigEntry } from './resolved-config'
import { withoutExtension } from './schema-binding'

/** A config array's files, app-relative and without extension; `null` when it cannot be read whole. */
function configArrayFiles(declared: Node, program: { body: unknown[] }, cwd: string, fromFile: string): string[] | null {
  const files = importedArrayFiles(declared, program, cwd, fromFile)
  // One element this cannot name would make every other verdict a guess.
  if (!files || files.includes(null)) return null
  return (files as string[]).map((file) => toPosixRelative(cwd, file))
}

interface Lister {
  /** `createApp({ config }) in src/app.ts`, or `defineModule({ config }) in a module's entry file`. */
  readonly label: string
  /** The file holding the array. */
  readonly file: string
  /** A module `createApp({ modules })` does not list: nothing reads its array. */
  readonly unmounted?: string
}

interface Listings {
  readonly root: Lister
  /** Keyed by the listed file without extension, and by `<dir>/index` for a directory import. */
  readonly byFile: ReadonlyMap<string, readonly Lister[]>
  /** Each module's descriptor file, by module name. */
  readonly descriptors: ReadonlyMap<string, string>
  /** Modules `createApp({ modules })` does not list, by name, as `modules/<name>`. */
  readonly unmounted: ReadonlyMap<string, string>
}

/** Every config array the app holds, or `null` when one of them cannot be read whole. */
async function readListings(cwd: string, cache: ParseCache, entryPath: string): Promise<Listings | null> {
  const entryFile = resolve(cwd, entryPath)
  const parsed = await cache.get(entryFile)
  const options = parsed ? createAppOptions(parsed.ast.program) : null
  if (!parsed || !options) return null

  const root: Lister = { label: `createApp({ config }) in ${entryPath}`, file: entryPath }
  const byFile = new Map<string, Lister[]>()
  const descriptors = new Map<string, string>()
  const unmounted = new Map<string, string>()
  const list = (files: string[], lister: Lister) => {
    for (const file of files) {
      for (const key of [file, `${file}/index`]) byFile.set(key, [...(byFile.get(key) ?? []), lister])
    }
  }

  // No `config` option wires nothing, which is the finding itself.
  const rootConfig = propertyValue(options, 'config')
  if (rootConfig !== undefined) {
    const files = configArrayFiles(rootConfig, parsed.ast.program, cwd, entryFile)
    if (files === null) return null
    list(files, root)
  }

  for (const { module, dir } of await listAppRoots(cwd)) {
    if (module === null) continue
    const descriptor = await readModuleDescriptor(cwd, cache, dir)
    if (descriptor === 'absent') continue
    const mount = moduleMountState(options, parsed.ast.program, cwd, entryFile, dir)
    // Only a module the boot may read can list a file; an unmounted one is judged by what it spells.
    const mayBeRead = mount === 'mounted' || mount === 'not-array' || mount === 'untraceable'
    const moduleDir = toPosixRelative(cwd, dir)
    if (!mayBeRead) unmounted.set(module, moduleDir)
    // Not a readable `defineModule({…})`, or keys hidden beside no `config`: either may list any file.
    const declared = descriptor === 'unreadable' ? undefined : propertyValue(descriptor.options, 'config')
    const files = descriptor === 'unreadable'
      ? null
      : declared === undefined
        ? (hidesKeys(descriptor.options) ? null : [])
        : configArrayFiles(declared, descriptor.ast.program, cwd, resolve(cwd, descriptor.file))
    if (files === null) {
      if (mayBeRead) return null
      continue
    }
    if (descriptor === 'unreadable') continue
    descriptors.set(module, descriptor.file)
    if (files.length === 0) continue
    if (mount === 'not-array' || mount === 'untraceable') return null

    list(files, { label: `defineModule({ config }) in ${descriptor.file}`, file: descriptor.file, ...(mount === 'mounted' ? {} : { unmounted: moduleDir }) })
  }
  return { root, byFile, descriptors, unmounted }
}

/** Only a file an array lists can fail; everything else is a warning or nothing at all. */
function judge(entry: ResolvedConfigEntry, read: readonly Lister[], unmounted: readonly Lister[], entryPath: string, listings: Listings): CheckResult | null {
  const title = 'Config wiring'
  if (read.length === 0) {
    if (entry.problem) return null
    const declares = `${entry.file} declares the "${entry.key}" config`
    const consequence = 'Nothing reads it, so the defaults apply instead.'
    const module = moduleNameFromRelPath(entry.file)
    let why: string
    let fix: string
    // An unmounted module whose descriptor this cannot read may list the file; what is certain is that nothing mounts it.
    const unreadUnmounted = module !== null && !listings.descriptors.has(module) ? listings.unmounted.get(module) : undefined
    if (unmounted[0]) {
      why = `${declares}, and ${unmounted[0].label} lists it, but createApp({ modules }) in ${entryPath} does not list ${unmounted[0].unmounted}.`
      fix = `Add the module to createApp({ modules: [...] }) in ${entryPath}.`
    } else if (unreadUnmounted !== undefined) {
      why = `${declares}, but createApp({ modules }) in ${entryPath} does not list ${unreadUnmounted}.`
      fix = `Add the module to createApp({ modules: [...] }) in ${entryPath}.`
    } else if (module !== null) {
      why = `${declares}, but neither its module's defineModule({ config }) nor createApp({ config }) in ${entryPath} lists it.`
      fix = `Add it to defineModule({ config: [...] }) in ${listings.descriptors.get(module) ?? scaffoldedModuleDescriptor(module)}.`
    } else {
      why = `${declares}, but ${entryPath} does not list it in createApp({ config }).`
      fix = `Add it to createApp({ config: [...] }) in ${entryPath}.`
    }
    return check(`config-unwired:${entry.file}`, title, 'warn', `${why} ${consequence}`, fix, entry.file)
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

interface Judged {
  readonly entry: ResolvedConfigEntry
  /** The arrays the boot reads that list the entry. */
  readonly read: readonly Lister[]
}

/** The boot refuses a key two read arrays define (`ConfigServiceProvider`), so this reports it first. */
function judgeDistinctKeys(judged: readonly Judged[]): CheckResult[] {
  const byKey = new Map<string, Array<{ file: string; label: string }>>()
  for (const { entry, read } of judged) {
    // Only these two carry the file's name in place of the definition's key.
    if (entry.problem === 'import-failed' || entry.problem === 'not-a-definition') continue
    const places = byKey.get(entry.key) ?? []
    places.push(...read.map(({ label }) => ({ file: entry.file, label })))
    byKey.set(entry.key, places)
  }
  return [...byKey].filter(([, places]) => places.length > 1).map(([key, places]) =>
    check(
      `config-duplicate-key:${key}`,
      'Config wiring',
      'fail',
      `The "${key}" config is listed ${places.length} times: ${places.map(({ file, label }) => `${file} by ${label}`).join(', ')}. The boot fails on the second.`,
      'Keep one definition per key across createApp({ config }) and every module\'s defineModule({ config }).',
      places[1]!.file,
    ),
  )
}

export async function checkConfigWiring(options: { cwd: string; cache: ParseCache }): Promise<CheckResult[]> {
  const { cwd, cache } = options

  // Before the import: an app this cannot judge should not have its config/ executed.
  const entryPath = await resolveAppEntry(cwd)
  const listings = entryPath === null ? null : await readListings(cwd, cache, entryPath)
  if (listings === null || entryPath === null) return []

  // A file only an unmounted module lists is not forced in; one that reads as a definition is imported anyway.
  const readFiles = [...listings.byFile].filter(([, listers]) => listers.some((lister) => !lister.unmounted)).map(([file]) => `${file}.ts`)
  const resolved = await loadResolvedConfig(cwd, new Set(readFiles))
  const judged: Judged[] = []
  const results: CheckResult[] = []
  for (const entry of resolved.entries) {
    const listers = listings.byFile.get(withoutExtension(entry.file)) ?? []
    const read = listers.filter((lister) => !lister.unmounted)
    judged.push({ entry, read })
    const result = judge(entry, read, listers.filter((lister) => lister.unmounted), entryPath, listings)
    if (result) results.push(result)
  }

  // Before the early return: the boot refuses a duplicate before any resolve() runs.
  const duplicates = judgeDistinctKeys(judged)
  const wired = judged.filter(({ entry, read }) => !entry.problem && read.length > 0)
  if (wired.length === 0) return [...results, ...duplicates]

  const moduleListers = new Set(wired.flatMap(({ read }) => read).filter((lister) => lister !== listings.root))
  const summary = moduleListers.size === 0
    ? `${entryPath} lists ${wired.length} config definition(s) in createApp({ config }).`
    : `${wired.length} config definition(s) are listed across ${entryPath} and ${[...moduleListers].map((lister) => lister.file).sort().join(', ')}.`
  return [check('config-wired', 'Config wiring', 'pass', summary), ...results, ...duplicates]
}
