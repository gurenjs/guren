/**
 * Config wiring checks (RFC 0027 §6). A `config/<key>.ts` definition the entry's
 * `createApp({ config: [...] })` never lists binds nothing, which looks exactly
 * like a configured app until the first request; a file the array *does* list
 * that is not a definition fails the boot. Both rules judge only files the array
 * names or definitions the import found, so an app whose `config/` holds plain
 * modules contributes nothing.
 */
import { dirname, relative, resolve } from 'node:path'
import type { Node, ObjectExpression } from '@babel/types'
import { objectLiteral, propertyValue, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { check, type CheckResult } from './check-result'
import type { ParseCache } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'
import { loadResolvedConfig } from './resolved-config'

/**
 * The module each identifier in `createApp({ config })` comes from, resolved to an
 * app-relative path without its extension. `null` when the array cannot be read:
 * a `config: definitions` naming a variable is not evidence that anything is unwired.
 */
function wiredConfigModules(ast: { program: unknown }, cwd: string, entryPath: string): Set<string> | null {
  let options: ObjectExpression | null = null
  walk(ast.program, (node) => {
    if (options) return false
    if (node.type !== 'CallExpression') return
    const callee = node.callee as BabelNode | undefined
    // Assignment-shape independent: every shipped entry writes `const app = createApp({...})`.
    if (callee?.type !== 'Identifier' || callee.name !== 'createApp') return
    options = objectLiteral((node.arguments as Node[])[0])
    return false
  })
  if (!options) return null

  // No `config` option wires nothing, which is the finding itself; one this scan
  // cannot read (`config: definitions`) is not evidence either way.
  const declared = propertyValue(options, 'config')
  if (declared === undefined) return new Set()
  const array = unwrapTypeAssertion(declared as Node)
  if (array?.type !== 'ArrayExpression') return null

  const names = new Set<string>()
  for (const element of array.elements) {
    const value = element ? unwrapTypeAssertion(element as Node) : null
    if (value?.type === 'Identifier') names.add(value.name)
  }

  const modules = new Set<string>()
  walk(ast.program, (node) => {
    if (node.type !== 'ImportDeclaration') return
    const source = (node.source as { value?: unknown }).value
    if (typeof source !== 'string') return
    const imported = (node.specifiers as BabelNode[]).some((specifier) => {
      const local = specifier.local as { name?: string } | undefined
      return Boolean(local?.name && names.has(local.name))
    })
    if (imported) modules.add(moduleTarget(cwd, entryPath, source))
  })
  return modules
}

/** `./config/session`, `../config/session` and `@/config/session` all name one file. */
function moduleTarget(cwd: string, entryPath: string, specifier: string): string {
  const absolute = specifier.startsWith('@/')
    ? resolve(cwd, specifier.slice(2))
    : resolve(dirname(resolve(cwd, entryPath)), specifier)
  return relative(cwd, absolute).replace(/\\/gu, '/').replace(/\.[jt]s$/u, '')
}

export async function checkConfigWiring(options: { cwd: string; cache: ParseCache }): Promise<CheckResult[]> {
  const { cwd, cache } = options
  const resolved = await loadResolvedConfig(cwd)
  if (resolved.entries.length === 0) return []

  const entryPath = await resolveAppEntry(cwd)
  const parsed = entryPath === null ? null : await cache.get(resolve(cwd, entryPath))
  const wired = parsed && entryPath ? wiredConfigModules(parsed.ast, cwd, entryPath) : null
  if (!wired) return []

  const results: CheckResult[] = []
  for (const entry of resolved.entries) {
    const listed = wired.has(entry.file.replace(/\.[jt]s$/u, ''))
    const title = 'Config wiring'

    if (listed && entry.problem !== undefined) {
      results.push(check(
        `config-not-a-definition:${entry.file}`,
        title,
        'fail',
        `${entryPath} lists ${entry.file} in createApp({ config }), but it ${entry.problem}. The boot fails on it.`,
        `Default-export a definition from ${entry.file} (defineSessionConfig, defineCacheConfig, …), or drop it from the array.`,
        entry.file,
      ))
      continue
    }
    if (entry.problem !== undefined) continue

    results.push(listed
      ? check(`config-wired:${entry.file}`, title, 'pass', `${entry.file} is listed in createApp({ config }).`)
      : check(
        `config-unwired:${entry.file}`,
        title,
        'warn',
        `${entry.file} declares the "${entry.key}" config, but ${entryPath} does not list it in createApp({ config }). Nothing reads it, so the defaults apply instead.`,
        `Add it to createApp({ config: [...] }) in ${entryPath}.`,
        entry.file,
      ))
  }
  return results
}
