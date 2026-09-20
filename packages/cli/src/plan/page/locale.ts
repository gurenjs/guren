/**
 * The page's own words. Only the shipped dictionaries are ever a template, so nothing
 * a plan says is formatted; a worded node re-reads its phrase when the locale changes.
 */

import type { PlanLocale } from '../locales'
import { byId, clear, el, isNode, own } from './dom'
import type { PlanPageI18n } from './payload'

export type PhraseValue = string | number | boolean | Node | null | undefined
export type PhraseValues = Record<string, PhraseValue>
type Values = PhraseValues | (() => PhraseValues) | undefined

// Page-wide, unlike the review: which language someone reads is not a fact about one plan.
const LOCALE_KEY = 'guren.plan.locale'
const CHROME = ['tabs', 'controls', 'footer']

let i18n: PlanPageI18n
let uiLocale: PlanLocale
const localised: Array<() => void> = []

/**
 * A dictionary value is a template, and the template decides the order:
 * `a {actor} calls {route}` and `{actor} が {route} を呼ぶ` take the same values.
 * A value is only ever text or a node, never a template, so a plan string
 * spelling `{route}` is written out as those seven characters.
 */
export function formatInto<T extends Node>(host: T, template: string, values?: PhraseValues): T {
  const pattern = /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g
  let last = 0
  // A node has one parent: appended twice it would move, and the first site go blank.
  const placed: Node[] = []
  const text = (value: string): void => {
    host.appendChild(document.createTextNode(value))
  }
  for (let match = pattern.exec(template); match !== null; match = pattern.exec(template)) {
    if (match.index > last) text(template.slice(last, match.index))
    const name = match[1]
    const value = values && own(values, name) ? values[name] : undefined
    // An unknown placeholder stays on the page as written: a blank would read as a
    // finished sentence with a word missing.
    if (value === undefined || value === null) text(match[0])
    else if (isNode(value)) {
      host.appendChild(placed.indexOf(value) === -1 ? value : value.cloneNode(true))
      placed.push(value)
    } else text(String(value))
    last = pattern.lastIndex
  }
  if (last < template.length) text(template.slice(last))
  return host
}

/** For the places that take a string: an attribute, an `option`, a placeholder. */
export function formatText(template: string, values?: PhraseValues): string {
  return formatInto(el('span'), template, values).textContent
}

function supported(locale: unknown): locale is PlanLocale {
  return typeof locale === 'string' && own(i18n.dictionaries, locale)
}

export function initLocale(given: PlanPageI18n): void {
  i18n = given
  uiLocale = given.initial
  try {
    const remembered = window.localStorage.getItem(LOCALE_KEY)
    if (supported(remembered)) uiLocale = remembered
  } catch {
    /* Storage is refused on some `file://` origins; the initial locale stands. */
  }
}

export function currentLocale(): PlanLocale {
  return uiLocale
}

/** A key neither locale has comes back spelled out rather than blank. */
function phrase(key: string): string {
  if (own(i18n.dictionaries[uiLocale], key)) return i18n.dictionaries[uiLocale][key]
  if (own(i18n.dictionaries.en, key)) return i18n.dictionaries.en[key]
  return '{' + key + '}'
}

function resolve(values: Values): PhraseValues | undefined {
  return typeof values === 'function' ? values() : values
}

export function t(key: string, values?: Values): string {
  return formatText(phrase(key), resolve(values))
}

/** Runs now, and again whenever the locale changes. */
export function localise(apply: () => void): void {
  localised.push(apply)
  apply()
}

/**
 * `node` says `key` in the current locale, and carries that locale's `lang`: the
 * document's own `lang` is the plan's, which need not be the one the page speaks.
 */
export function words<T extends Element>(node: T, key: string, values?: Values): T {
  localise(() => {
    node.setAttribute('lang', uiLocale)
    clear(node)
    formatInto(node, phrase(key), resolve(values))
  })
  return node
}

export function tel<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string | null,
  key: string,
  values?: Values,
): HTMLElementTagNameMap[K] {
  return words(el(tag, className), key, values)
}

/** For what is redrawn on a locale change anyway: binding it would keep every discarded copy alive. */
export function spoken<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, key: string): HTMLElementTagNameMap[K] {
  const node = el(tag, className, t(key))
  node.setAttribute('lang', uiLocale)
  return node
}

/** The attribute is named here, not passed in: the page sets none by a computed name. */
export function ariaLabel(node: Element, key: string, values?: Values): void {
  localise(() => {
    node.setAttribute('aria-label', t(key, values))
  })
}

/**
 * Nothing is rebuilt: every worded node re-reads its phrase in place, so the open
 * tab, the filter, the hash, the answers and the review are what they were.
 */
function setLocale(locale: string): void {
  if (!supported(locale)) return
  uiLocale = locale
  for (const apply of localised) apply()
}

export function mountLocaleSwitch(): void {
  localise(() => {
    for (const id of CHROME) byId(id).setAttribute('lang', uiLocale)
  })

  const localeSelect = byId<HTMLSelectElement>('locale-select')
  words(byId('locale-switch-label'), 'locale.switch')
  for (const [locale, dictionary] of Object.entries(i18n.dictionaries)) {
    // Each language is named in itself, whichever one the page is speaking.
    const option = el('option', null, own(dictionary, 'locale.name') ? dictionary['locale.name'] : locale)
    option.value = locale
    option.setAttribute('lang', locale)
    localeSelect.appendChild(option)
  }
  byId('locale-switch').hidden = localeSelect.childNodes.length < 2
  localeSelect.addEventListener('change', () => {
    setLocale(localeSelect.value)
    try {
      window.localStorage.setItem(LOCALE_KEY, uiLocale)
    } catch {
      /* The switch still works for this visit. */
    }
  })

  localeSelect.value = uiLocale
}
