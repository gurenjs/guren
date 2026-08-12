import { posix } from 'node:path'

import { Marked, type Tokens } from 'marked'
import { markedHighlight } from 'marked-highlight'
import { codeToHtml } from 'shiki'

import { docPaths, GITHUB_URL } from '../../config/site.js'
import {
  docCategoryDir,
  docLocaleDir,
  normalizeDocSlug,
  DOC_CATEGORY_KEYS,
  DOC_LOCALE_KEYS,
  type DocCategory,
  type DocLocale,
} from './docs-config.js'

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

export interface DocLinkContext {
  locale: DocLocale
  category: DocCategory
}

const CATEGORY_BY_DIR = new Map(DOC_CATEGORY_KEYS.map((key) => [docCategoryDir(key), key]))
const LOCALE_BY_DIR = new Map(DOC_LOCALE_KEYS.map((key) => [docLocaleDir(key), key]))

/**
 * Docs source keeps GitHub-compatible relative `.md` links; the site rewrites
 * them at render time. Links that resolve to a published doc become route
 * paths (`/docs/ja/guides/routing`), links that escape the docs tree point at
 * the file on GitHub, and everything else (absolute URLs, anchors, non-md
 * relative paths) passes through untouched.
 */
export function rewriteDocLink(href: string, context: DocLinkContext): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(href)) {
    return href
  }

  const hashIndex = href.indexOf('#')
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex)
  const beforeHash = hashIndex === -1 ? href : href.slice(0, hashIndex)
  const queryIndex = beforeHash.indexOf('?')
  const suffix = queryIndex === -1 ? hash : `${beforeHash.slice(queryIndex)}${hash}`
  const path = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex)

  if (!/\.md$/iu.test(path)) {
    return href
  }

  // Resolve against the source file's repo directory: docs/<locale>/<category>/.
  const joined = posix.join(
    'docs',
    docLocaleDir(context.locale),
    docCategoryDir(context.category),
    path,
  )
  if (joined === '..' || joined.startsWith('../')) {
    return href
  }

  const segments = joined.split('/')
  if (segments.length === 4 && segments[0] === 'docs') {
    const locale = LOCALE_BY_DIR.get(segments[1])
    const category = CATEGORY_BY_DIR.get(segments[2])
    const slug = segments[3].replace(/\.md$/iu, '')
    // A slug the docs routes would reject (normalizeDocSlug) is not a
    // published page — fall through to the GitHub source link instead.
    if (locale && category && normalizeDocSlug(slug) === slug) {
      return `${docPaths(category, slug)[locale]}${suffix}`
    }
  }

  return `${GITHUB_URL}/blob/main/${joined}${suffix}`
}

export async function renderMarkdownToHtml(
  markdown: string,
  linkContext?: DocLinkContext,
): Promise<string> {
  // A fresh instance per render keeps the heading slug map and link context
  // request-scoped — safe for concurrent requests.
  const seenSlugs = new Map<string, number>()
  const instance = new Marked()
  instance.setOptions({ gfm: true, breaks: false, async: true })

  instance.use(
    markedHighlight({
      async: true,
      highlight: async (code: string, lang?: string) => {
        const normalizedLang = lang?.trim() || DEFAULT_LANGUAGE
        try {
          return await codeToHtml(code, { lang: normalizedLang, themes: DOCS_THEMES, defaultColor: 'light' })
        } catch {
          return await codeToHtml(code, { lang: DEFAULT_LANGUAGE, themes: DOCS_THEMES, defaultColor: 'light' })
        }
      },
    }),
  )

  instance.use({
    walkTokens(token) {
      if (linkContext && token.type === 'link' && typeof token.href === 'string') {
        token.href = rewriteDocLink(token.href, linkContext)
        return
      }
      if (token.type !== 'blockquote' || !token.tokens?.length) return
      const first = token.tokens[0]
      if (first.type !== 'paragraph') return
      const alertType = extractAlertType(first as Tokens.Paragraph)
      if (!alertType) return
      ;(token as Tokens.Blockquote & { alertType?: AlertType }).alertType = alertType
      if (!first.text.trim()) token.tokens.shift()
    },
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const text = this.parser.parseInline(tokens)
        const id = slugifyHeading(text, seenSlugs)
        return `<h${depth} id="${id}">${text}</h${depth}>\n`
      },
      blockquote(token) {
        const content = this.parser.parse(token.tokens ?? [])
        const alertType = (token as Tokens.Blockquote & { alertType?: AlertType }).alertType
        if (!alertType) return `<blockquote>\n${content}</blockquote>\n`
        const meta = ALERT_METADATA[alertType]
        return `<div class="docs-alert docs-alert--${meta.classSuffix}">
  <p class="docs-alert__label">${meta.label}</p>
  <div class="docs-alert__body">
${content}
  </div>
</div>`
      },
    },
  })

  const rendered = await instance.parse(markdown, { async: true })
  return typeof rendered === 'string' ? rendered : ''
}

/**
 * One pass of `/<[^>]*>/g` as a linear scan — the regex itself is quadratic
 * on `<`-heavy input with no closing bracket. Unclosed `<` tails are kept
 * verbatim, matching the regex (which requires a closing `>`).
 */
function stripHtmlTagsOnce(html: string): string {
  let out = ''
  let i = 0
  while (i < html.length) {
    const open = html.indexOf('<', i)
    if (open === -1) {
      return out + html.slice(i)
    }
    const close = html.indexOf('>', open + 1)
    if (close === -1) {
      return out + html.slice(i)
    }
    out += html.slice(i, open)
    i = close + 1
  }
  return out
}

function slugifyHeading(text: string, seenSlugs: Map<string, number>): string {
  // Repeat until stable: a single pass can splice a new tag together
  // (e.g. `<scr<x>ipt>` becomes `<script>` after one removal).
  let stripped = text
  let previous: string
  do {
    previous = stripped
    stripped = stripHtmlTagsOnce(stripped)
  } while (stripped !== previous)
  let slug = stripped
    .toLowerCase()
    .trim()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}\-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  slug = slug || `heading-${Math.random().toString(36).slice(2, 8)}`

  const count = seenSlugs.get(slug) ?? 0
  seenSlugs.set(slug, count + 1)
  if (count > 0) {
    slug = `${slug}-${count}`
  }
  return slug
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
