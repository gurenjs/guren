import { Lexer, type Tokens } from 'marked'

import { FEATURE_ICONS, type FeatureIconKey } from '../../config/feature-icons.js'

/**
 * A docs feature list: bold-led paragraphs between `<!-- features -->` and
 * `<!-- /features -->`, each after a `<!-- feature-icon: <key> -->` line.
 * GitHub hides the comments; the site renders the run as icon cards.
 * Markers are read from marked's block tokens, so one inside a code fence or
 * an attribute value is left alone.
 */
const LIST_OPEN = '<!-- features -->'
const LIST_CLOSE = '<!-- /features -->'
const ICON_MARKER = /^<!--\s*feature-icon:\s*([a-z-]+)\s*-->$/u

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'

const MISPLACED =
  'A <!-- features --> block may hold only paragraphs that open with **bold** and follow a <!-- feature-icon: <key> --> line'

function isFeatureIcon(key: string): key is FeatureIconKey {
  return Object.hasOwn(FEATURE_ICONS, key)
}

/**
 * The card stays markdown: an HTML line opens it, and the title and body are
 * separate paragraphs, so marked renders their inline content as on any page.
 */
function featureItem(icon: string, paragraph: Tokens.Paragraph): string {
  if (!isFeatureIcon(icon)) {
    throw new Error(`Unknown feature icon "${icon}"; add it to web/config/feature-icons.ts`)
  }
  const title = paragraph.tokens[0]
  if (title?.type !== 'strong' || !paragraph.raw.startsWith(title.raw)) {
    throw new Error(MISPLACED)
  }
  const body = paragraph.raw.slice(title.raw.length).trim()
  const open = `<li class="doc-feature"><span class="doc-feature-icon">${SVG_OPEN}${FEATURE_ICONS[icon]}</svg></span>`
  return `${open}\n\n${title.raw}\n\n${body === '' ? '' : `${body}\n\n`}</li>\n\n`
}

/** Throws on an unknown icon, a stray token inside a block, or an unclosed block. */
export function expandFeatureLists(markdown: string): string {
  if (!markdown.includes(LIST_OPEN)) {
    return markdown
  }

  let output = ''
  let inList = false
  let icon: string | null = null
  for (const token of Lexer.lex(markdown, { gfm: true })) {
    const html = token.type === 'html' ? token.raw.trim() : null
    if (!inList) {
      inList = html === LIST_OPEN
      output += inList ? '<ul class="doc-features">\n\n' : token.raw
      continue
    }
    if (token.type === 'space') {
      continue
    }
    if (html === LIST_CLOSE && icon === null) {
      inList = false
      output += '</ul>\n\n'
      continue
    }
    const marker: RegExpExecArray | null = html === null || icon !== null ? null : ICON_MARKER.exec(html)
    if (marker) {
      icon = marker[1]!
    } else if (icon !== null && token.type === 'paragraph') {
      output += featureItem(icon, token as Tokens.Paragraph)
      icon = null
    } else {
      throw new Error(MISPLACED)
    }
  }
  if (inList) {
    throw new Error('A <!-- features --> block is missing its <!-- /features --> line')
  }
  return output
}
