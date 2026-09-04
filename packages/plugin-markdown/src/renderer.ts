import { Marked, type MarkedExtension, type Tokens } from 'marked'
import { markedHighlight } from 'marked-highlight'
import sanitizeHtml from 'sanitize-html'

import { alertsExtension, type AlertType } from './alerts'
import { defaultSanitizeOptions } from './sanitize'
import { createSlugger } from './slugger'

/**
 * Code-fence highlighter. A result beginning with `<pre` is emitted as-is
 * (shiki's shape — properly escaped inner HTML can never start with a literal
 * `<`); anything else is wrapped in the default `<pre><code>`.
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
  /**
   * Label text per alert type, for i18n or a different vocabulary. Class names
   * are unaffected; an explicit empty string empties the label, an omitted type
   * keeps its default.
   */
  alertLabels?: Partial<Record<AlertType, string>>
  /** Heading `id` attributes via the hardened slugger. Default true. */
  anchors?: boolean
  /** Rewrite every link `href` before rendering (e.g. relative `.md` → routes). */
  rewriteLink?: (href: string) => string
  /**
   * Rewrite every image `src` before rendering. Separate from `rewriteLink`
   * because the two resolve against different roots: a link points at another
   * document, an image at a served asset.
   */
  rewriteImage?: (src: string) => string
  /** Optional code-fence highlighter. Without it, fences render as plain `<pre><code>`. */
  highlight?: HighlightFn
}

export interface MarkdownRenderer {
  render(markdown: string): Promise<string>
}

/**
 * Builds a markdown → HTML renderer with the RFC 0012 defaults: GFM, sanitized
 * output, alerts, heading anchors. `render()` is a pure async function of its
 * input — per-render state (the slug map, the `Marked` instance) is created
 * inside the call — so one renderer is safe under concurrent requests, and
 * nothing is cached.
 */
export function createMarkdownRenderer(options: MarkdownRendererOptions = {}): MarkdownRenderer {
  const {
    gfm = true,
    sanitize = true,
    alerts = true,
    anchors = true,
    alertLabels,
    rewriteLink,
    rewriteImage,
    highlight,
  } = options

  const sanitizeOptions =
    sanitize === false
      ? null
      : typeof sanitize === 'function'
        ? sanitize(defaultSanitizeOptions())
        : defaultSanitizeOptions()

  // Extensions capturing no per-render state, built once and shared. Only the
  // heading renderer is per-render: it owns the slug map.
  const staticExtensions: MarkedExtension[] = []
  if (highlight) {
    staticExtensions.push(
      markedHighlight({
        async: true,
        // HighlightFn may return a plain string; the async marked-highlight
        // overload requires a Promise.
        highlight: async (code: string, lang?: string) => highlight(code, lang),
      }),
      {
        renderer: {
          // Block-level highlighters (shiki) return a complete <pre> block;
          // wrapping it again nests two code blocks. `false` falls through to
          // the default renderer, which already treats the text as escaped.
          code({ text }: Tokens.Code) {
            return text.startsWith('<pre') ? `${text}\n` : false
          },
        },
      },
    )
  }
  if (alerts) {
    staticExtensions.push(alertsExtension(alertLabels))
  }
  if (rewriteLink || rewriteImage) {
    // `link` and `image` both carry their target in `href`, so one pass
    // covers them; which rewriter applies is the only difference.
    staticExtensions.push({
      walkTokens(token) {
        if (token.type === 'link' && rewriteLink && typeof token.href === 'string') {
          token.href = rewriteLink(token.href)
        } else if (token.type === 'image' && rewriteImage && typeof token.href === 'string') {
          token.href = rewriteImage(token.href)
        }
      },
    })
  }

  return {
    async render(markdown: string): Promise<string> {
      const instance = new Marked()
      instance.setOptions({ gfm, breaks: false })
      for (const extension of staticExtensions) {
        instance.use(extension)
      }

      if (anchors) {
        const slugify = createSlugger()
        instance.use({
          renderer: {
            heading({ tokens, depth }: Tokens.Heading) {
              const text = this.parser.parseInline(tokens)
              return `<h${depth} id="${slugify(text)}">${text}</h${depth}>\n`
            },
          },
        })
      }

      const html = await instance.parse(markdown, { async: true })
      return sanitizeOptions ? sanitizeHtml(html, sanitizeOptions) : html
    },
  }
}
