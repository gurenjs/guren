/**
 * The keys of `defineEnv({ … })` in `config/env.ts` RFC 0040 §5 reads as facts. An edit is those facts only when the
 * file differs from its base by keys added to that literal and the `Env` import they need; a key changed or removed,
 * or anything else in the file, keeps it `source-edited`.
 */

import type { ImportDeclaration, ObjectProperty, Program } from '@babel/types'

import { canonicalSyntax, memberKeyName, sameComments } from '../ast-walk'
import { declaredEnvKeys, defineEnvOptions, frameworkEnvImports } from '../env-declarations'
import { parseSourceFile } from '../parse-cache'

const FRAMEWORK = new Set(['@guren/core', '@guren/server'])

/**
 * The framework imports with `Env` taken out and their specifiers in name order, as `ensureNamedImports()` rewrites
 * them. Only a declaration that held nothing but `Env` goes; any other import, a bare `import '@guren/core'`
 * included, stays in the comparison.
 */
function normalizeImports(program: Program): void {
  const emptied = new Set<ImportDeclaration>()
  for (const { declaration, index } of frameworkEnvImports(program).reverse()) {
    declaration.specifiers.splice(index, 1)
    if (declaration.specifiers.length === 0) emptied.add(declaration)
  }
  program.body = program.body.filter((node) => node.type !== 'ImportDeclaration' || !emptied.has(node))
  for (const node of program.body) {
    if (node.type === 'ImportDeclaration' && FRAMEWORK.has(node.source.value)) node.specifiers.sort((a, b) => (a.local.name < b.local.name ? -1 : a.local.name > b.local.name ? 1 : 0))
  }
}

/**
 * The keys `head` adds to the `defineEnv()` literal of `base`, in order; `undefined` when the files differ by anything
 * else (a key removed, changed or moved, another statement) or either does not parse. Importing `Env` from the
 * framework goes with the keys; dropping it does not.
 */
export function envKeyAdditions(base: string, head: string, path: string): string[] | undefined {
  const [before, after] = [parseSourceFile(base, path), parseSourceFile(head, path)]
  if (!before || !after || !sameComments(before, base, after, head)) return undefined
  const [baseOptions, headOptions] = [defineEnvOptions(before.program), defineEnvOptions(after.program)]
  if (!baseOptions || !headOptions) return undefined
  if (frameworkEnvImports(before.program).length > 0 && frameworkEnvImports(after.program).length === 0) return undefined

  const kept = baseOptions.properties as ObjectProperty[]
  const baseKeys = new Set(declaredEnvKeys(baseOptions).map((entry) => entry.key))
  const remaining: ObjectProperty[] = []
  const added: string[] = []
  let at = 0
  for (const property of headOptions.properties as ObjectProperty[]) {
    if (at < kept.length && canonicalSyntax(property) === canonicalSyntax(kept[at])) {
      remaining.push(property)
      at += 1
      continue
    }
    const key = memberKeyName(property)!
    // A key the base declares, written again, is that key changed.
    if (baseKeys.has(key) || added.includes(key)) return undefined
    added.push(key)
  }
  if (at !== kept.length) return undefined
  headOptions.properties = remaining
  normalizeImports(before.program)
  normalizeImports(after.program)
  return canonicalSyntax(after.program) === canonicalSyntax(before.program) ? added : undefined
}

/** The builder chain `source`'s `defineEnv()` literal gives `key`, or `undefined` when the literal cannot be read or does not hold it once. */
export function envKeyValue(source: string, path: string, key: string): ObjectProperty['value'] | undefined {
  const ast = parseSourceFile(source, path)
  const options = ast ? defineEnvOptions(ast.program) : undefined
  const matches = options ? declaredEnvKeys(options).filter((entry) => entry.key === key) : []
  return matches.length === 1 ? matches[0]!.value : undefined
}

/** Whether `source` imports `Env` from the framework, which a planned declaration's `Env.<type>()` is read as. */
export function importsFrameworkEnv(source: string, path: string): boolean {
  const ast = parseSourceFile(source, path)
  return ast !== null && frameworkEnvImports(ast.program).length > 0
}
