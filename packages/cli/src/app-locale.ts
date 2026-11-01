/**
 * The locale an application falls back to, read from `createApp({ i18n })` without
 * running it. Positive evidence only: an option built elsewhere, or no `i18n` at all,
 * is no answer rather than a guessed one.
 */
import { resolve } from 'node:path'
import type { Node } from '@babel/types'

import { literalString, objectLiteral, propertyValue, unwrapTypeAssertion } from './ast-walk'
import { createAppOptions } from './app-entry'
import { ParseCache } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'

/** `none`: the entry's `createApp({ … })` literal declares no `i18n`; `unknown`: it may, but this cannot read the locale. */
export type AppLocaleReading = { kind: 'locale'; locale: string } | { kind: 'none' } | { kind: 'unknown' }

export async function readAppDefaultLocale(cwd: string): Promise<string | undefined> {
  const reading = await readAppLocale(cwd)
  return reading.kind === 'locale' ? reading.locale : undefined
}

export async function readAppLocale(cwd: string): Promise<AppLocaleReading> {
  const unknown = { kind: 'unknown' } as const
  const entry = await resolveAppEntry(cwd)
  if (entry === null) return unknown

  const parsed = await new ParseCache().get(resolve(cwd, entry))
  const options = parsed ? createAppOptions(parsed.ast.program) : null
  if (!options) return unknown
  const option = propertyValue(options, 'i18n')
  if (option === undefined) return options.properties.some((property) => property.type !== 'ObjectProperty') ? unknown : { kind: 'none' }
  const i18n = objectLiteral(option)
  if (!i18n) return unknown

  // A spread may carry a `fallback` this cannot see, and one that is not a literal names
  // a locale this cannot read: either way `supported[0]` would be a guess.
  if (i18n.properties.some((property) => property.type !== 'ObjectProperty')) return unknown
  const declared = propertyValue(i18n, 'fallback')
  if (declared !== undefined) return found(literalString(declared))
  // `fallback` defaults to the first supported locale at runtime, so the same order here.
  const supported = propertyValue(i18n, 'supported')
  const first = supported ? unwrapTypeAssertion(supported) : undefined
  if (first?.type !== 'ArrayExpression') return unknown
  return found(literalString(first.elements[0] as Node | null))
}

function found(locale: string | null): AppLocaleReading {
  return locale === null ? { kind: 'unknown' } : { kind: 'locale', locale }
}
