/**
 * GitHub-style blockquote alerts (`> [!NOTE]` …), ported from guren.dev's
 * docs pipeline (RFC 0012) with framework-neutral class names. The package
 * ships a reference stylesheet (`@guren/plugin-markdown/styles.css`) but
 * applies no styling itself.
 */
import type { Tokens } from 'marked'

export const ALERT_DIRECTIVE_PATTERN = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/iu

export type AlertType = 'note' | 'tip' | 'important' | 'warning' | 'caution'

export const ALERT_LABELS: Record<AlertType, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
}

/**
 * Detects an alert directive at the head of a blockquote's first paragraph
 * and removes it from the paragraph's text/tokens so it does not render.
 * Returns the alert type, or null when the blockquote is a plain quote.
 */
export function extractAlertType(paragraph: Tokens.Paragraph): AlertType | null {
  const match = paragraph.text.match(ALERT_DIRECTIVE_PATTERN)
  if (!match) {
    return null
  }

  const normalizedType = match[1].toLowerCase() as AlertType
  paragraph.text = paragraph.text.replace(ALERT_DIRECTIVE_PATTERN, '').trimStart()

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

export function renderAlertHtml(alertType: AlertType, contentHtml: string): string {
  return `<div class="guren-markdown-alert guren-markdown-alert--${alertType}">
  <p class="guren-markdown-alert__label">${ALERT_LABELS[alertType]}</p>
  <div class="guren-markdown-alert__body">
${contentHtml}
  </div>
</div>`
}
