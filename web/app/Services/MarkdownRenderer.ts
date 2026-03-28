import { Marked, type Tokens } from 'marked'
import { markedHighlight } from 'marked-highlight'
import { codeToHtml } from 'shiki'

const DOCS_THEMES = {
  light: 'rose-pine-dawn',
  dark: 'rose-pine-moon',
} as const
const DEFAULT_LANGUAGE = 'text'
const ALERT_DIRECTIVE_PATTERN = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/iu

type AlertType = 'note' | 'tip' | 'important' | 'warning' | 'caution'

const ALERT_METADATA: Record<
  AlertType,
  { label: string; classSuffix: string }
> = {
  note: { label: 'Note', classSuffix: 'note' },
  tip: { label: 'Tip', classSuffix: 'tip' },
  important: { label: 'Important', classSuffix: 'important' },
  warning: { label: 'Warning', classSuffix: 'warning' },
  caution: { label: 'Caution', classSuffix: 'caution' },
}

const markedInstance = new Marked()

markedInstance.setOptions({
  gfm: true,
  breaks: false,
  async: true,
})

markedInstance.use(
  markedHighlight({
    async: true,
    highlight: async (code: string, lang?: string) => {
      const normalizedLang = lang?.trim() || DEFAULT_LANGUAGE

      try {
        return await codeToHtml(code, {
          lang: normalizedLang,
          themes: DOCS_THEMES,
          defaultColor: 'light',
        })
      }
      catch {
        return await codeToHtml(code, {
          lang: DEFAULT_LANGUAGE,
          themes: DOCS_THEMES,
          defaultColor: 'light',
        })
      }
    },
  }),
)

markedInstance.use({
  walkTokens(token) {
    if (token.type !== 'blockquote' || !token.tokens?.length) {
      return
    }

    const first = token.tokens[0]
    if (first.type !== 'paragraph') {
      return
    }

    const alertType = extractAlertType(first as Tokens.Paragraph)
    if (!alertType) {
      return
    }

    ;(token as Tokens.Blockquote & { alertType?: AlertType }).alertType = alertType

    if (!first.text.trim()) {
      token.tokens.shift()
    }
  },
  renderer: {
    heading({ tokens, depth }: Tokens.Heading) {
      const text = this.parser.parseInline(tokens)
      const id = slugifyHeading(text)
      return `<h${depth} id="${id}">${text}</h${depth}>\n`
    },
    blockquote(token) {
      const content = this.parser.parse(token.tokens ?? [])
      const alertType = (token as Tokens.Blockquote & { alertType?: AlertType }).alertType

      if (!alertType) {
        return `<blockquote>\n${content}</blockquote>\n`
      }

      const meta = ALERT_METADATA[alertType]
      const className = `docs-alert docs-alert--${meta.classSuffix}`

      return `<div class="${className}">
  <p class="docs-alert__label">${meta.label}</p>
  <div class="docs-alert__body">
${content}
  </div>
</div>`
    },
  },
})

export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  const rendered = await markedInstance.parse(markdown, { async: true })
  return typeof rendered === 'string' ? rendered : ''
}

function slugifyHeading(text: string): string {
  const stripped = text.replace(/<[^>]*>/g, '')
  const slug = stripped
    .toLowerCase()
    .trim()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}\-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || `heading-${Math.random().toString(36).slice(2, 8)}`
}

function extractAlertType(paragraph: Tokens.Paragraph): AlertType | null {
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
