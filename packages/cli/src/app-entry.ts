/**
 * The one reading of how an app composes itself: the entry's `createApp({ … })`
 * options, what its `modules` array lists, and each module's `defineModule({ … })`
 * descriptor (RFC 0002). `guren check` and `plan:status` judge wiring through it,
 * so the two cannot disagree about whether a module is mounted.
 */
import { resolve } from 'node:path'
import type { File, Node, ObjectExpression } from '@babel/types'
import { objectLiteral, propertyValue, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { findFirstExisting, moduleDescriptorCandidates, toPosixRelative } from './discovery'
import type { ParseCache } from './parse-cache'
import { importsByLocal, specifierBase, withoutExtension } from './schema-binding'

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
 * Each element of an array option traced to the file its identifier is imported
 * from, absolute and without extension; `null` for an element this cannot trace.
 * `undefined` when the value is not an array literal.
 */
export function importedArrayFiles(
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

/** Whether a spread or a computed key may carry a key the literal does not spell. */
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
  if (files.some((file) => file === moduleDir || file === resolve(moduleDir, 'index'))) return 'mounted'
  return files.includes(null) ? 'untraceable' : 'unlisted'
}

export interface ModuleDescriptor {
  /** App-relative, as a check result names it. */
  readonly file: string
  readonly ast: File
  readonly options: ObjectExpression
}

/**
 * A module's `modules/<name>/index.*` and the literal its `defineModule()` takes.
 * `absent` when there is no descriptor file, `unreadable` when it does not parse
 * or holds no `defineModule({ … })` call.
 */
export async function readModuleDescriptor(
  cwd: string,
  cache: ParseCache,
  moduleDir: string,
): Promise<ModuleDescriptor | 'absent' | 'unreadable'> {
  const file = await findFirstExisting(cwd, moduleDescriptorCandidates(toPosixRelative(cwd, moduleDir)))
  if (file === null) return 'absent'
  const parsed = await cache.get(resolve(cwd, file))
  const options = parsed ? firstCallOptions(parsed.ast.program, 'defineModule') : null
  return parsed && options ? { file, ast: parsed.ast, options } : 'unreadable'
}
