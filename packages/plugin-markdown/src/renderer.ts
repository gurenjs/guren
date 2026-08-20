import { Marked, type MarkedExtension, type Tokens } from 'marked'
import { markedHighlight } from 'marked-highlight'
import sanitizeHtml from 'sanitize-html'

import { alertsExtension } from './alerts'
import { defaultSanitizeOptions } from './sanitize'
import { createSlugger } from './slugger'

/**
 * Code-fence highlighter. Receives the fence body and the (possibly absent)
 * language tag. A result that begins with `<pre` is treated as a complete
 * code block and emitted as-is (shiki's shape — properly escaped inner HTML
 * can never start with a literal `<`); anything else is wrapped in the
 * default `<pre><code>`. `createShikiHighlight` from
 * `@guren/plugin-markdown/shiki` produces one; any compatible function works.
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

  // Extensions that capture no per-render state, built once and shared:
  // marked's use() only reads them, and token mutation is scoped to each
  // parse. Only the heading renderer is per-render (it owns the slug map).
  const staticExtensions: MarkedExtension[] = []
  if (highlight) {
    staticExtensions.push(
      markedHighlight({
        async: true,
        // The wrapper is load-bearing: HighlightFn may return a plain
        // string, while the async marked-highlight overload requires a
        // Promise.
        highlight: async (code: string, lang?: string) => highlight(code, lang),
      }),
      {
        renderer: {
          // Block-level highlighters (shiki) return a complete <pre> block;
          // wrapping that in the default <pre><code> again nests two code
          // blocks. Emit it unwrapped; anything else falls through to the
          // default renderer (`false`), which marked-highlight has already
          // marked as escaped.
          code({ text }: Tokens.Code) {
            return text.startsWith('<pre') ? `${text}\n` : false
          },
        },
      },
    )
  }
  if (alerts) {
    staticExtensions.push(alertsExtension())
  }
  if (rewriteLink) {
    staticExtensions.push({
      walkTokens(token) {
        if (token.type === 'link' && typeof token.href === 'string') {
          token.href = rewriteLink(token.href)
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
