/**
 * The one reading of how an app composes itself: the entry's `createApp({ … })`
 * options, what its `modules` array lists, and each module's `defineModule({ … })`
 * descriptor (RFC 0002). `guren check` and `plan:status` judge wiring through it,
 * so the two cannot disagree about whether a module is mounted.
 */
import { basename, dirname, resolve, sep } from 'node:path'
import type { File, Node, ObjectExpression } from '@babel/types'
import { objectLiteral, propertyValue, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { toPosixRelative } from './discovery'
import { moduleEntryFile } from './import-resolution'
import type { ParseCache } from './parse-cache'
import { importsByLocal, specifierBase, withoutExtension, type ImportEntry } from './schema-binding'

/** The object literal the first `callee({ … })` call takes; a call passing anything else is skipped. */
export function firstCallOptions(program: unknown, callee: string): ObjectExpression | null {
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

/** The literal `createApp({ … })` takes, or `null` when the entry passes anything else. */
export function createAppOptions(program: unknown): ObjectExpression | null {
  return firstCallOptions(program, 'createApp')
}

/**
 * Each element of an array option traced to the import its identifier names, `file` absolute
 * and without extension (`null` when `specifierBase` cannot resolve it); `null` for an element
 * that is not an imported identifier. `undefined` when the value is not an array literal.
 */
function importedArrayEntries(
  declared: Node,
  program: { body: unknown[] },
  cwd: string,
  fromFile: string,
): Array<{ file: string | null; kind: ImportEntry['kind']; specifier: string } | null> | undefined {
  const array = unwrapTypeAssertion(declared)
  if (array.type !== 'ArrayExpression') return undefined

  const imports = importsByLocal(program.body as never)
  return array.elements.map((element) => {
    const value = element ? unwrapTypeAssertion(element as Node) : null
    const entry = value?.type === 'Identifier' ? imports.get(value.name) : undefined
    if (entry === undefined) return null
    const base = specifierBase(cwd, fromFile, entry.source)
    return { file: base === null ? null : withoutExtension(base), kind: entry.kind, specifier: entry.source }
  })
}

/** {@link importedArrayEntries} as files; `null` for an element this cannot trace to one. */
export function importedArrayFiles(
  declared: Node,
  program: { body: unknown[] },
  cwd: string,
  fromFile: string,
): Array<string | null> | undefined {
  return importedArrayEntries(declared, program, cwd, fromFile)?.map((entry) => entry?.file ?? null)
}

/** The package an import specifier names, `name` or `@scope/name`, without its subpath. */
function packageOf(specifier: string): string {
  const [first = '', second] = specifier.split('/')
  return first.startsWith('@') && second !== undefined ? `${first}/${second}` : first
}

/** Whether an import traced to `listed` names the module at `target`, a directory through its index. */
function importedAs(listed: string, target: string): boolean {
  return listed === target || resolve(listed, 'index') === target
}

/**
 * Whether `createApp({ providers, config })` in `entryFile` imports one of `files` (absolute).
 * `null` is no evidence, and on purpose broader than what `guren check` reads: an element this
 * cannot trace, an import that may re-export one of them, or a specifier outside `packages`
 * (the app's declared dependencies), which may be a path alias. A wrong `false` tells the user
 * to register the file a second time.
 */
export function createAppListsFile(
  program: File['program'],
  cwd: string,
  entryFile: string,
  files: readonly string[],
  packages: ReadonlySet<string>,
): boolean | null {
  const options = createAppOptions(program)
  if (!options) return null
  const wanted = files.map(withoutExtension)
  let untraced = false
  for (const key of ['providers', 'config']) {
    const declared = propertyValue(options, key)
    const entries = declared === undefined
      ? (hidesKeys(options) ? undefined : [])
      : importedArrayEntries(declared, program, cwd, entryFile)
    if (entries === undefined) {
      untraced = true
      continue
    }
    for (const entry of entries) {
      if (entry === null) {
        untraced = true
        continue
      }
      const { file, kind, specifier } = entry
      if (file === null) {
        if (!packages.has(packageOf(specifier))) untraced = true
        continue
      }
      if (wanted.some((target) => importedAs(file, target))) return true
      // A named import may come from a barrel, a default one from a directory's index.
      const dir = basename(file) === 'index' ? dirname(file) : file
      if (kind !== 'default' || wanted.some((target) => target.startsWith(`${dir}${sep}`))) untraced = true
    }
  }
  return untraced ? null : false
}

/**
 * Whether a spread or a computed key may carry a key the literal does not spell.
 * A method is named (`routes(router) {}` is a registrar), so unlike `staticProperty` it hides nothing.
 */
export function hidesKeys(options: ObjectExpression): boolean {
  return options.properties.some((property) => property.type === 'SpreadElement' || property.computed)
}

/**
 * Whether `createApp({ modules })` mounts `modules/<name>`: `no-modules` when the
 * option is absent from options that spread nothing, `not-array` when it is absent
 * behind a spread or not an array literal, `untraceable` when an element this
 * cannot trace to a file may be it.
 */
export type ModuleMountState = 'mounted' | 'no-modules' | 'not-array' | 'untraceable' | 'unlisted'

export function moduleMountState(
  options: ObjectExpression,
  program: { body: unknown[] },
  cwd: string,
  entryFile: string,
  moduleDir: string,
): ModuleMountState {
  const declared = propertyValue(options, 'modules')
  const files = declared === undefined ? undefined : importedArrayFiles(declared, program, cwd, entryFile)
  if (files === undefined) return declared === undefined && !hidesKeys(options) ? 'no-modules' : 'not-array'
  if (files.some((file) => file !== null && importedAs(file, resolve(moduleDir, 'index')))) return 'mounted'
  return files.includes(null) ? 'untraceable' : 'unlisted'
}

export interface ModuleDescriptor {
  /** App-relative, as a check result names it. */
  readonly file: string
  readonly ast: File
  readonly options: ObjectExpression
}

/** The descriptor file `make:module` scaffolds, named as the file to create when a module has none. */
export const MODULE_DESCRIPTOR_FILE = 'index.ts'

/** A module's entry file ({@link moduleEntryFile}), relative to `cwd`; null when it has none. */
export async function findModuleDescriptor(cwd: string, moduleDir: string): Promise<string | null> {
  const file = await moduleEntryFile(resolve(cwd, moduleDir))
  return file === null ? null : toPosixRelative(cwd, file)
}

/**
 * A module's entry file and the literal its `defineModule()` takes.
 * `absent` when there is no descriptor file, `unreadable` when it does not parse
 * or holds no `defineModule({ … })` call.
 */
export async function readModuleDescriptor(
  cwd: string,
  cache: ParseCache,
  moduleDir: string,
): Promise<ModuleDescriptor | 'absent' | 'unreadable'> {
  const file = await findModuleDescriptor(cwd, moduleDir)
  if (file === null) return 'absent'
  const parsed = await cache.get(resolve(cwd, file))
  const options = parsed ? firstCallOptions(parsed.ast.program, 'defineModule') : null
  return parsed && options ? { file, ast: parsed.ast, options } : 'unreadable'
}
