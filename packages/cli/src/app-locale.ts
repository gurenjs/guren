/**
 * The locale an application falls back to, read from `createApp({ i18n })` without
 * running it. Positive evidence only: an option built elsewhere, or no `i18n` at all,
 * is no answer rather than a guessed one.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Node } from '@babel/types'

import { literalString, objectLiteral, propertyValue, unwrapTypeAssertion } from './ast-walk'
import { createAppOptions } from './config-check'
import { parseSourceFile } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'

export async function readAppDefaultLocale(cwd: string): Promise<string | undefined> {
  const entry = await resolveAppEntry(cwd)
  if (entry === null) return undefined

  let source: string
  try {
    source = await readFile(resolve(cwd, entry), 'utf8')
  } catch {
    return undefined
  }
  const ast = parseSourceFile(source, entry)
  const i18n = ast ? objectLiteral(propertyValue(createAppOptions(ast.program), 'i18n')) : null
  if (!i18n) return undefined

  // A spread may carry a `fallback` this cannot see, and one that is not a literal names
  // a locale this cannot read: either way `supported[0]` would be a guess.
  if (i18n.properties.some((property) => property.type !== 'ObjectProperty')) return undefined
  const declared = propertyValue(i18n, 'fallback')
  if (declared !== undefined) return literalString(declared) ?? undefined
  // `fallback` defaults to the first supported locale at runtime, so the same order here.
  const supported = propertyValue(i18n, 'supported')
  const first = supported ? unwrapTypeAssertion(supported) : undefined
  if (first?.type !== 'ArrayExpression') return undefined
  return literalString(first.elements[0] as Node | null) ?? undefined
}
