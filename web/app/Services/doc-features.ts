import { FEATURE_ICONS, type FeatureIconKey } from '../../config/feature-icons.js'

/**
 * A docs feature list, written as plain bold-led paragraphs between
 * `<!-- features -->` and `<!-- /features -->`, each preceded by
 * `<!-- feature-icon: <key> -->`. GitHub hides the comments, so the source
 * still reads as paragraphs there; the site renders the run as icon cards.
 */
const FEATURE_LIST = /<!--\s*features\s*-->([\s\S]*?)<!--\s*\/features\s*-->/gu
const FEATURE_ITEM =
  /\s*<!--\s*feature-icon:\s*([a-z-]+)\s*-->\s*<p><strong>([\s\S]*?)<\/strong>\s*([\s\S]*?)<\/p>\s*/gu

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'

function isFeatureIcon(key: string): key is FeatureIconKey {
  return Object.hasOwn(FEATURE_ICONS, key)
}

function renderItem(icon: string, title: string, body: string): string {
  if (!isFeatureIcon(icon)) {
    throw new Error(`Unknown feature icon "${icon}"; add it to web/config/feature-icons.ts`)
  }
  return (
    `<li class="doc-feature">` +
    `<span class="doc-feature-icon">${SVG_OPEN}${FEATURE_ICONS[icon]}</svg></span>` +
    `<div class="doc-feature-body"><strong class="doc-feature-title">${title}</strong><p>${body}</p></div>` +
    `</li>`
  )
}

/** Throws on an unknown icon or a block holding anything but feature paragraphs. */
export function renderFeatureLists(html: string): string {
  return html.replace(FEATURE_LIST, (_, inner: string) => {
    const items: string[] = []
    const rest = inner.replace(FEATURE_ITEM, (_item, icon: string, title: string, body: string) => {
      items.push(renderItem(icon, title, body))
      return ''
    })
    if (rest.trim() !== '' || items.length === 0) {
      throw new Error(
        'A <!-- features --> block may hold only paragraphs that open with **bold** and follow a <!-- feature-icon: <key> --> line',
      )
    }
    return `<ul class="doc-features">${items.join('')}</ul>\n`
  })
}
