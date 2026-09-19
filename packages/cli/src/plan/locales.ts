/**
 * The plan page's own words (RFC 0030 §3): one dictionary per locale, shipped beside
 * the template. They are the page's chrome and sentence frames only. Plan text and
 * check results are never looked up here.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { extractPlaceholders } from '../i18n-check'

export const PLAN_LOCALES = ['en', 'ja'] as const
export type PlanLocale = (typeof PLAN_LOCALES)[number]
export type PlanDictionary = Record<string, string>

// Same two hops as the template in `render.ts`: `dist/` is one below the package root, `src/plan/` two.
const LANG_CANDIDATES = ['../assets/plan/lang/', '../../assets/plan/lang/'] as const

export function isPlanLocale(value: string): value is PlanLocale {
  return (PLAN_LOCALES as readonly string[]).includes(value)
}

/** The supported locale a BCP 47 tag falls under by its language: `ja-JP` is `ja`, `fr` is none. */
export function matchPlanLocale(tag: string | undefined): PlanLocale | undefined {
  const language = tag?.split('-')[0]?.toLowerCase()
  return language !== undefined && isPlanLocale(language) ? language : undefined
}

/** A dictionary value with string values only, as a caller outside the page prints it. */
export function formatPlanPhrase(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? values[name]! : whole,
  )
}

export function parsePlanDictionary(locale: string, raw: string): PlanDictionary {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The ${locale} plan dictionary is not a JSON object.`)
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`The ${locale} plan dictionary holds a non-string value at ${key}.`)
  }
  return parsed as PlanDictionary
}

const cached = new Map<PlanLocale, PlanDictionary>()

export function loadPlanDictionary(locale: PlanLocale): PlanDictionary {
  const hit = cached.get(locale)
  if (hit !== undefined) return hit
  const tried: string[] = []
  for (const candidate of LANG_CANDIDATES) {
    const path = fileURLToPath(new URL(`${candidate}${locale}.json`, import.meta.url))
    try {
      const dictionary = parsePlanDictionary(locale, readFileSync(path, 'utf8'))
      cached.set(locale, dictionary)
      return dictionary
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      tried.push(path)
    }
  }
  throw new Error(`Could not locate the ${locale} plan dictionary shipped with @guren/cli. Tried:\n  ${tried.join('\n  ')}`)
}

export function loadPlanDictionaries(): Record<PlanLocale, PlanDictionary> {
  return Object.fromEntries(PLAN_LOCALES.map((locale) => [locale, loadPlanDictionary(locale)])) as Record<
    PlanLocale,
    PlanDictionary
  >
}

export interface PlanDictionaryProblem {
  key: string
  kind: 'missing' | 'extra' | 'placeholders' | 'colon-placeholder'
  message: string
}

const sorted = (names: Set<string>): string => [...names].sort().join(', ') || '(none)'

/**
 * `candidate` against `reference`, key by key. The page's formatter reads `{name}` only,
 * while `extractPlaceholders()` also reads `:name`; a value spelling one would be counted
 * as a placeholder here and printed as text there, so it is reported on either side.
 */
export function comparePlanDictionaries(reference: PlanDictionary, candidate: PlanDictionary): PlanDictionaryProblem[] {
  const problems: PlanDictionaryProblem[] = []

  for (const [name, dictionary] of [
    ['reference', reference],
    ['candidate', candidate],
  ] as const) {
    for (const [key, value] of Object.entries(dictionary)) {
      if (/:[A-Za-z_]/.test(value)) {
        problems.push({ key, kind: 'colon-placeholder', message: `${key} in the ${name} spells a :name placeholder.` })
      }
    }
  }

  for (const key of Object.keys(reference)) {
    if (!Object.hasOwn(candidate, key)) {
      problems.push({ key, kind: 'missing', message: `${key} is missing.` })
      continue
    }
    const expected = extractPlaceholders(reference[key]!)
    const actual = extractPlaceholders(candidate[key]!)
    if (expected.size !== actual.size || [...expected].some((name) => !actual.has(name))) {
      problems.push({
        key,
        kind: 'placeholders',
        message: `${key} takes ${sorted(expected)} in the reference and ${sorted(actual)} here.`,
      })
    }
  }

  for (const key of Object.keys(candidate)) {
    if (!Object.hasOwn(reference, key)) problems.push({ key, kind: 'extra', message: `${key} is in no other dictionary.` })
  }

  return problems
}
