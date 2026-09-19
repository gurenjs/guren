/**
 * Config wiring checks (RFC 0027 §6). A `config/<key>.ts` definition the entry's
 * `createApp({ config: [...] })` never lists binds nothing, which looks exactly
 * like a configured app until the first request; a file the array does list that
 * is not a definition fails the boot. An array this cannot read whole is no
 * evidence either way, and reports nothing.
 */
import { resolve } from 'node:path'
import type { Node, ObjectExpression } from '@babel/types'
import { objectLiteral, propertyValue, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { check, type CheckResult } from './check-result'
import { toPosixRelative } from './discovery'
import type { ParseCache } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'
import { loadResolvedConfig, type ResolvedConfigEntry } from './resolved-config'
import { importsByLocal, specifierBase } from './schema-binding'

/** The literal `createApp({ … })` takes, or `null` when the entry passes anything else. */
export function createAppOptions(program: unknown): ObjectExpression | null {
  let options: ObjectExpression | null = null
  walk(program, (node) => {
    if (options) return false
    if (node.type !== 'CallExpression') return
    const callee = node.callee as BabelNode | undefined
    // Assignment-shape independent: every shipped entry writes `const app = createApp({…})`.
    if (callee?.type !== 'Identifier' || callee.name !== 'createApp') return
    options = objectLiteral((node.arguments as Node[])[0])
    return false
  })
  return options
}

/**
 * The files `createApp({ config })` lists, app-relative and without extension,
 * each also spelled as its `index` form. `null` when the array cannot be read
 * whole: one element this cannot name would make every other verdict a guess.
 */
function wiredConfigModules(
  ast: { program: { body: unknown[] } },
  cwd: string,
  entryPath: string,
): Set<string> | null {
  const options = createAppOptions(ast.program)
  if (!options) return null

  // No `config` option wires nothing, which is the finding itself.
  const declared = propertyValue(options, 'config')
  if (declared === undefined) return new Set()
  const array = unwrapTypeAssertion(declared as Node)
  if (array?.type !== 'ArrayExpression') return null

  const names: string[] = []
  for (const element of array.elements) {
    const value = element ? unwrapTypeAssertion(element as Node) : null
    if (value?.type !== 'Identifier') return null
    names.push(value.name)
  }

  const imports = importsByLocal(ast.program.body as never)
  const modules = new Set<string>()
  for (const name of names) {
    const source = imports.get(name)?.source
    const base = source === undefined ? null : specifierBase(cwd, resolve(cwd, entryPath), source)
    if (base === null) continue
    const relative = toPosixRelative(cwd, base).replace(/\.[jt]s$/u, '')
    modules.add(relative)
    modules.add(`${relative}/index`)
  }
  return modules
}

/** Only a file the entry wired can fail; everything else is a warning or nothing at all. */
function judge(entry: ResolvedConfigEntry, listed: boolean, entryPath: string): CheckResult | null {
  const title = 'Config wiring'
  if (!listed) {
    return entry.problem
      ? null
      : check(
        `config-unwired:${entry.file}`,
        title,
        'warn',
        `${entry.file} declares the "${entry.key}" config, but ${entryPath} does not list it in createApp({ config }). Nothing reads it, so the defaults apply instead.`,
        `Add it to createApp({ config: [...] }) in ${entryPath}.`,
        entry.file,
      )
  }

  if (entry.problem === 'not-a-definition') {
    return check(
      `config-not-a-definition:${entry.file}`,
      title,
      'fail',
      `${entryPath} lists ${entry.file} in createApp({ config }), but it ${entry.detail}. The boot fails on it.`,
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

export async function checkConfigWiring(options: { cwd: string; cache: ParseCache }): Promise<CheckResult[]> {
  const { cwd, cache } = options

  // Before the import: an app this cannot judge should not have its config/ executed.
  const entryPath = await resolveAppEntry(cwd)
  const parsed = entryPath === null ? null : await cache.get(resolve(cwd, entryPath))
  const wired = parsed && entryPath ? wiredConfigModules(parsed.ast, cwd, entryPath) : null
  if (!wired || entryPath === null) return []

  const resolved = await loadResolvedConfig(cwd, new Set([...wired].map((file) => `${file}.ts`)))
  const results = resolved.entries.flatMap((entry) => {
    const result = judge(entry, wired.has(entry.file.replace(/\.[jt]s$/u, '')), entryPath)
    return result ? [result] : []
  })

  const wiredCount = resolved.entries.filter((entry) => wired.has(entry.file.replace(/\.[jt]s$/u, '')) && !entry.problem).length
  return wiredCount === 0
    ? results
    : [check('config-wired', 'Config wiring', 'pass', `${entryPath} lists ${wiredCount} config definition(s) in createApp({ config }).`), ...results]
}
