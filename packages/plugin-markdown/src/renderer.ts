import { Marked, type MarkedExtension, type Tokens } from 'marked'
import { markedHighlight } from 'marked-highlight'
import sanitizeHtml from 'sanitize-html'

import { extractAlertType, renderAlertHtml, type AlertType } from './alerts'
import { defaultSanitizeOptions } from './sanitize'
import { createSlugger } from './slugger'

/**
 * Code-fence highlighter. Receives the fence body and the (possibly absent)
 * language tag, returns HTML for the whole block. `createShikiHighlight`
 * from `@guren/plugin-markdown/shiki` produces one; any compatible function
 * works.
 */
export type HighlightFn = (code: string, lang?: string) => string | Promise<string>

export interface MarkdownRendererOptions {
  /** GitHub Flavored Markdown (tables, strikethrough, autolinks). Default true. */
  gfm?: boolean
  /**
   * Sanitize the rendered HTML with the shiki-compatible allowlist.
   * Default true — `false` is the explicit opt-out for trusted content.
   * A callback receives the default options and returns the options to use,
   * so the allowlist can be extended without replacing it.
   */
  sanitize?: boolean | ((defaults: sanitizeHtml.IOptions) => sanitizeHtml.IOptions)
  /** GitHub-style `> [!NOTE]` blockquote alerts. Default true. */
  alerts?: boolean
  /** Heading `id` attributes via the hardened slugger. Default true. */
  anchors?: boolean
  /** Rewrite every link `href` before rendering (e.g. relative `.md` → routes). */
  rewriteLink?: (href: string) => string
  /** Optional code-fence highlighter. Without it, fences render as plain `<pre><code>`. */
  highlight?: HighlightFn
}

export interface MarkdownRenderer {
  render(markdown: string): Promise<string>
}

type AlertBlockquote = Tokens.Blockquote & { alertType?: AlertType }

/**
 * Builds a markdown → HTML renderer with the RFC 0012 defaults: GFM,
 * sanitized output, alerts, and heading anchors.
 *
 * `render()` is a pure async function of its input: per-render state (the
 * slug uniqueness map, the `Marked` instance) is created inside the call, so
 * one renderer is safe under concurrent requests. Whether the app renders at
 * save time or request time is the app's choice — there is no cache here.
 */
export function createMarkdownRenderer(options: MarkdownRendererOptions = {}): MarkdownRenderer {
  const {
    gfm = true,
    sanitize = true,
    alerts = true,
    anchors = true,
    rewriteLink,
    highlight,
  } = options

  const sanitizeOptions =
    sanitize === false
      ? null
      : typeof sanitize === 'function'
        ? sanitize(defaultSanitizeOptions())
        : defaultSanitizeOptions()

  return {
    async render(markdown: string): Promise<string> {
      const slugify = createSlugger()
      const instance = new Marked()
      instance.setOptions({ gfm, breaks: false, async: true })

      if (highlight) {
        instance.use(
          markedHighlight({
            async: true,
            highlight: async (code: string, lang?: string) => highlight(code, lang),
          }),
        )
      }

      const renderer: NonNullable<MarkedExtension['renderer']> = {}
      if (anchors) {
        renderer.heading = function ({ tokens, depth }: Tokens.Heading) {
          const text = this.parser.parseInline(tokens)
          return `<h${depth} id="${slugify(text)}">${text}</h${depth}>\n`
        }
      }
      if (alerts) {
        renderer.blockquote = function (token: Tokens.Blockquote) {
          const content = this.parser.parse(token.tokens ?? [])
          const alertType = (token as AlertBlockquote).alertType
          if (!alertType) return `<blockquote>\n${content}</blockquote>\n`
          return renderAlertHtml(alertType, content)
        }
      }

      instance.use({
        walkTokens(token) {
          if (rewriteLink && token.type === 'link' && typeof token.href === 'string') {
            token.href = rewriteLink(token.href)
            return
          }
          if (!alerts) return
          if (token.type !== 'blockquote' || !token.tokens?.length) return
          const first = token.tokens[0]
          if (first.type !== 'paragraph') return
          const alertType = extractAlertType(first as Tokens.Paragraph)
          if (!alertType) return
          ;(token as AlertBlockquote).alertType = alertType
          if (!first.text.trim()) token.tokens.shift()
        },
        renderer,
      })

      const rendered = await instance.parse(markdown, { async: true })
      const html = typeof rendered === 'string' ? rendered : ''
      return sanitizeOptions ? sanitizeHtml(html, sanitizeOptions) : html
    },
  }
}
