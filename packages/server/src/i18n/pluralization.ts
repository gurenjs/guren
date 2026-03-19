import type { PluralizationRule } from './types'

/**
 * Default pluralization rules for common languages.
 *
 * Returns the index of the plural form to use.
 * Most languages use: 0 = one, 1 = other
 * Some languages have more complex rules.
 */
export const pluralizationRules: Record<string, PluralizationRule> = {
  /**
   * English, German, Spanish, Italian, Portuguese, etc.
   * 1 = singular, everything else = plural
   */
  en: (count: number) => (count === 1 ? 0 : 1),
  de: (count: number) => (count === 1 ? 0 : 1),
  es: (count: number) => (count === 1 ? 0 : 1),
  it: (count: number) => (count === 1 ? 0 : 1),
  pt: (count: number) => (count === 1 ? 0 : 1),
  nl: (count: number) => (count === 1 ? 0 : 1),

  /**
   * French, Brazilian Portuguese
   * 0 and 1 = singular, everything else = plural
   */
  fr: (count: number) => (count <= 1 ? 0 : 1),
  'pt-BR': (count: number) => (count <= 1 ? 0 : 1),

  /**
   * Japanese, Chinese, Korean, Vietnamese, Thai
   * No plural forms
   */
  ja: () => 0,
  zh: () => 0,
  ko: () => 0,
  vi: () => 0,
  th: () => 0,

  /**
   * Russian, Ukrainian, Serbian, Croatian, Bosnian
   * Three forms: one, few (2-4), many (5+)
   */
  ru: (count: number) => {
    const mod10 = count % 10
    const mod100 = count % 100
    if (mod10 === 1 && mod100 !== 11) return 0
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 1
    return 2
  },
  uk: (count: number) => {
    const mod10 = count % 10
    const mod100 = count % 100
    if (mod10 === 1 && mod100 !== 11) return 0
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 1
    return 2
  },

  /**
   * Polish
   * Three forms with different rules
   */
  pl: (count: number) => {
    if (count === 1) return 0
    const mod10 = count % 10
    const mod100 = count % 100
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 1
    return 2
  },

  /**
   * Czech, Slovak
   * Three forms: 1, 2-4, 5+
   */
  cs: (count: number) => {
    if (count === 1) return 0
    if (count >= 2 && count <= 4) return 1
    return 2
  },
  sk: (count: number) => {
    if (count === 1) return 0
    if (count >= 2 && count <= 4) return 1
    return 2
  },

  /**
   * Arabic
   * Six forms
   */
  ar: (count: number) => {
    if (count === 0) return 0
    if (count === 1) return 1
    if (count === 2) return 2
    const mod100 = count % 100
    if (mod100 >= 3 && mod100 <= 10) return 3
    if (mod100 >= 11) return 4
    return 5
  },
}

/**
 * Get pluralization rule for a locale.
 */
export function getPluralizationRule(locale: string): PluralizationRule {
  // Try exact match first
  if (pluralizationRules[locale]) {
    return pluralizationRules[locale]
  }

  // Try language code only (e.g., 'en' from 'en-US')
  const langCode = locale.split('-')[0]
  if (pluralizationRules[langCode]) {
    return pluralizationRules[langCode]
  }

  // Default to English-style pluralization
  return pluralizationRules.en
}

/**
 * Select the appropriate plural form from a translation.
 *
 * Translation format: "singular|plural" or "one|few|many"
 */
export function selectPluralForm(
  translation: string,
  count: number,
  rule: PluralizationRule
): string {
  const forms = translation.split('|')
  const index = rule(Math.abs(count))

  // Return the appropriate form, or the last one if index is out of bounds
  return forms[index] ?? forms[forms.length - 1]
}
