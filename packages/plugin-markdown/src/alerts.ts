/**
 * GitHub-style blockquote alerts (`> [!NOTE]` …), ported from guren.dev's
 * docs pipeline (RFC 0012) with framework-neutral class names. The package
 * ships a reference stylesheet (`@guren/plugin-markdown/styles.css`) but
 * applies no styling itself.
 *
 * This module is the single source of the alert vocabulary: the type set,
 * the directive pattern, the emitted markup, and the class names the default
 * sanitizer admits are all derived from `ALERT_LABELS` and
 * `ALERT_CLASS_PREFIX` here. (`styles.css` necessarily keeps a manual copy.)
 */
import type { MarkedExtension, Tokens } from 'marked'

export const ALERT_CLASS_PREFIX = 'guren-markdown-alert'

const ALERT_LABELS = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
} as const

export type AlertType = keyof typeof ALERT_LABELS

const ALERT_TYPES = Object.keys(ALERT_LABELS) as AlertType[]

const ALERT_DIRECTIVE_PATTERN = new RegExp(
  `^\\s*\\[!(${ALERT_TYPES.join('|')})\\]\\s*`,
  'iu',
)

type AlertBlockquote = Tokens.Blockquote & { alertType?: AlertType }

/** The class values the default sanitizer must admit for alert markup. */
export function alertAllowedClasses(): { div: string[]; p: string[] } {
  return {
    div: [
      ALERT_CLASS_PREFIX,
      ...ALERT_TYPES.map((type) => `${ALERT_CLASS_PREFIX}--${type}`),
      `${ALERT_CLASS_PREFIX}__body`,
    ],
    p: [`${ALERT_CLASS_PREFIX}__label`],
  }
}

/**
 * Detects an alert directive at the head of a blockquote's first paragraph
 * and removes it from the paragraph's text/tokens so it does not render.
 * Returns the alert type, or null when the blockquote is a plain quote.
 */
function extractAlertType(paragraph: Tokens.Paragraph): AlertType | null {
  const match = paragraph.text.match(ALERT_DIRECTIVE_PATTERN)
  if (!match) {
    return null
  }

  const normalizedType = match[1].toLowerCase() as AlertType
  paragraph.text = paragraph.text.slice(match[0].length).trimStart()

  if (paragraph.tokens?.length) {
    const firstToken = paragraph.tokens[0]
    if ('text' in firstToken && typeof firstToken.text === 'string') {
      firstToken.text = firstToken.text.replace(ALERT_DIRECTIVE_PATTERN, '').trimStart()
    }

    if ('raw' in firstToken && typeof firstToken.raw === 'string') {
      firstToken.raw = firstToken.raw.replace(ALERT_DIRECTIVE_PATTERN, '').trimStart()
    }
  }

  return normalizedType
}

/**
 * The whole alert mechanism as one marked extension: directive detection in
 * `walkTokens` (which tags the blockquote token and drops an emptied first
 * paragraph) and the matching blockquote renderer. Captures no per-render
 * state — one instance is safe to share across concurrent renders, since
 * token mutation is scoped to each parse.
 *
 * `labels` overrides the rendered label text per alert type (i18n, or a
 * different vocabulary — several types may share one label). Class names are
 * not affected: styling stays keyed to the directive that was written.
 */
export function alertsExtension(labels: Partial<Record<AlertType, string>> = {}): MarkedExtension {
  return {
    walkTokens(token) {
      if (token.type !== 'blockquote' || !token.tokens?.length) return
      const first = token.tokens[0]
      if (first.type !== 'paragraph') return
      const alertType = extractAlertType(first as Tokens.Paragraph)
      if (!alertType) return
      ;(token as AlertBlockquote).alertType = alertType
      if (!first.text.trim()) token.tokens.shift()
    },
    renderer: {
      blockquote(token: Tokens.Blockquote) {
        const content = this.parser.parse(token.tokens ?? [])
        const alertType = (token as AlertBlockquote).alertType
        if (!alertType) return `<blockquote>\n${content}</blockquote>\n`
        return `<div class="${ALERT_CLASS_PREFIX} ${ALERT_CLASS_PREFIX}--${alertType}">
  <p class="${ALERT_CLASS_PREFIX}__label">${labels[alertType] ?? ALERT_LABELS[alertType]}</p>
  <div class="${ALERT_CLASS_PREFIX}__body">
${content}
  </div>
</div>`
      },
    },
  }
}
