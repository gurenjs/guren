/**
 * Translation catalog consistency checks (`guren check --i18n`).
 *
 * Content-activated: apps without a `lang/` directory contribute zero
 * results. Three rules over `lang/<locale>/*.json`:
 *
 * - **Invalid JSON** (`fail`): JsonLoader skips unparseable files with only
 *   a console warning, so every key in the file silently disappears at
 *   runtime.
 * - **Key parity** (`fail`): a key present in some locale but missing from
 *   another renders in the fallback language for that locale's users.
 * - **Placeholder parity** (`warn`): `:name`/`{name}` placeholders that
 *   differ between locales for the same key usually mean a lost or
 *   mistranslated variable — warn rather than fail because a locale can
 *   legitimately drop a placeholder (e.g. a plural-less phrasing).
 *
 * Usage scanning (`t('...')` call sites referencing unknown keys) is
 * deliberately out of scope: the generated `TranslationKey` union already
 * enforces that at compile time without the false positives of an AST
 * heuristic.
 */
import { formatTruncatedList } from './discovery'
import { DEFAULT_LANG_DIR, readTranslationCatalogs, type TranslationCatalog } from './i18n-types'
import { check, type CheckResult } from './check-result'

export interface RunI18nCheckOptions {
  cwd: string
}

export async function runI18nCheck(options: RunI18nCheckOptions): Promise<CheckResult[]> {
  const langDir = DEFAULT_LANG_DIR
  const catalogs = await readTranslationCatalogs(options.cwd)
  if (catalogs.length === 0) {
    return []
  }

  const results: CheckResult[] = []

  for (const catalog of catalogs) {
    for (const file of catalog.invalidFiles) {
      results.push(
        check(
          `i18n-json:${file}`,
          file,
          'fail',
          `${file} is not valid JSON — the loader skips it, so all of its keys silently fall back at runtime.`,
          'Fix the JSON syntax, then rerun `guren codegen`.',
          file,
        ),
      )
    }
  }

  const allKeys = new Set(catalogs.flatMap((catalog) => [...catalog.entries.keys()]))

  for (const catalog of catalogs) {
    const missing = [...allKeys].filter((key) => !catalog.entries.has(key)).sort()

    results.push(
      check(
        `i18n-parity:${catalog.locale}`,
        `${langDir}/${catalog.locale} key parity`,
        missing.length === 0 ? 'pass' : 'fail',
        missing.length === 0
          ? `Covers all ${allKeys.size} translation keys.`
          : `Missing ${missing.length} of ${allKeys.size} keys: ${formatTruncatedList(missing, 5)}. These render in the fallback locale.`,
        missing.length === 0
          ? undefined
          : `Add the missing keys to ${langDir}/${catalog.locale}/ (namespace = file name).`,
      ),
    )
  }

  results.push(...checkPlaceholderParity(catalogs, allKeys, langDir))

  return results
}

/**
 * Placeholders a message interpolates: `:name` and `{name}` forms. Requires
 * an identifier-style leading character so times (`9:00`) and ratios don't
 * read as placeholders.
 */
export function extractPlaceholders(message: string): Set<string> {
  const placeholders = new Set<string>()
  for (const match of message.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    placeholders.add(match[1]!)
  }
  for (const match of message.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    placeholders.add(match[1]!)
  }
  return placeholders
}

function checkPlaceholderParity(
  catalogs: TranslationCatalog[],
  allKeys: Set<string>,
  langDir: string,
): CheckResult[] {
  const results: CheckResult[] = []

  for (const key of [...allKeys].sort()) {
    const holders = catalogs
      .filter((catalog) => catalog.entries.has(key))
      .map((catalog) => ({
        locale: catalog.locale,
        placeholders: extractPlaceholders(catalog.entries.get(key)!),
      }))
    if (holders.length < 2) continue

    const union = new Set(holders.flatMap((holder) => [...holder.placeholders]))
    const mismatched = holders.filter((holder) => holder.placeholders.size !== union.size)
    if (mismatched.length === 0) continue

    const detail = mismatched
      .map((holder) => {
        const missing = [...union].filter((name) => !holder.placeholders.has(name)).sort()
        return `${holder.locale} lacks :${missing.join(', :')}`
      })
      .join('; ')

    results.push(
      check(
        `i18n-placeholders:${key}`,
        `${key} placeholders`,
        'warn',
        `Placeholder mismatch across locales (${detail}).`,
        `Align the interpolated variables for '${key}' across ${langDir}/<locale>/, or confirm the wording intentionally drops them.`,
      ),
    )
  }

  return results
}
