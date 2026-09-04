/**
 * GitHub-style blockquote alerts (`> [!NOTE]` …), ported from guren.dev's docs
 * pipeline (RFC 0012) with framework-neutral class names; the package ships a
 * reference stylesheet but applies no styling itself. The single source of the
 * alert vocabulary — the type set, the directive pattern, the markup and the
 * class names the default sanitizer admits all derive from `ALERT_LABELS` and
 * `ALERT_CLASS_PREFIX` here. (`styles.css` keeps a manual copy.)
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

/**
 * Escape for both element and attribute contexts. Exported because consumers
 * passing `sanitize: false` still have to escape anything they hand back
 * through the `highlight` callback, where nothing downstream will.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

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

/** The directive at the head of a paragraph, removed from it, or null. */
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
 * The whole alert mechanism as one marked extension. Captures no per-render
 * state — one instance is safe to share across concurrent renders, since token
 * mutation is scoped to each parse. `labels` overrides the rendered label text
 * per alert type; class names stay keyed to the directive that was written, and
 * an explicit empty string keeps the label element while emptying it.
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
  <p class="${ALERT_CLASS_PREFIX}__label">${escapeHtml(labels[alertType] ?? ALERT_LABELS[alertType])}</p>
  <div class="${ALERT_CLASS_PREFIX}__body">
${content}
  </div>
</div>`
      },
    },
  }
}
