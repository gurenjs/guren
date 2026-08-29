import { posix } from 'node:path'

import { codeToHtml } from 'shiki'

import { createMarkdownRenderer, escapeHtml } from '@guren/plugin-markdown'

import { MARKDOWN_CODE_THEMES, SITE_ALERT_LABELS } from '../../config/markdown.js'
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

const DEFAULT_LANGUAGE = 'text'

/** Where screenshots live in the repo, and where the site serves them from. */
const DOCS_IMAGE_DIR = 'docs/images/'
const DOCS_IMAGE_URL_ROOT = '/docs-images/'

export interface DocLinkContext {
  locale: DocLocale
  category: DocCategory
}

const CATEGORY_BY_DIR = new Map(DOC_CATEGORY_KEYS.map((key) => [docCategoryDir(key), key]))
const LOCALE_BY_DIR = new Map(DOC_LOCALE_KEYS.map((key) => [docLocaleDir(key), key]))

/** Absolute URL, root-relative path, or bare anchor — never repo-relative. */
const NON_RELATIVE_TARGET = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu

/**
 * Where a repo-relative target resolves inside the docs tree, given the source
 * file's own `docs/<locale>/<category>/` directory. Returns `null` for targets
 * that escape the tree, and for anything still percent-encoded: `%2e%2e` would
 * survive posix.join only to be normalized by the browser afterwards, so the
 * containment both callers rely on has to be decided before that.
 */
function resolveInDocsTree(target: string, context: DocLinkContext): string | null {
  const joined = posix.join(
    'docs',
    docLocaleDir(context.locale),
    docCategoryDir(context.category),
    target,
  )
  if (joined === '..' || joined.startsWith('../') || joined.includes('%')) {
    return null
  }
  return joined
}

/**
 * Docs source keeps GitHub-compatible relative `.md` links; the site rewrites
 * them at render time. Links that resolve to a published doc become route
 * paths (`/docs/ja/guides/routing`), links that escape the docs tree point at
 * the file on GitHub, and everything else (absolute URLs, anchors, non-md
 * relative paths) passes through untouched.
 */
export function rewriteDocLink(href: string, context: DocLinkContext): string {
  if (NON_RELATIVE_TARGET.test(href)) {
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

  const joined = resolveInDocsTree(path, context)
  if (joined === null) {
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

/**
 * Docs source keeps GitHub-compatible relative image paths
 * (`../../images/foo.png`) so the pictures render on GitHub too. The site
 * serves the same files from `web/public/docs-images/`, copied there by
 * `scripts/copy-docs-images.ts` at build time, so the rendered `src` has to
 * be rewritten to that root. Anything resolving outside `docs/images/`
 * (absolute URLs, data URIs, an escape upward) passes through untouched.
 */
export function rewriteDocImage(src: string, context: DocLinkContext): string {
  if (NON_RELATIVE_TARGET.test(src)) {
    return src
  }

  const joined = resolveInDocsTree(src, context)
  if (joined === null || !joined.startsWith(DOCS_IMAGE_DIR)) {
    return src
  }

  return `${DOCS_IMAGE_URL_ROOT}${joined.slice(DOCS_IMAGE_DIR.length)}`
}

// Docs fences carry arbitrary languages, so this pipeline keeps the full
// shiki entry instead of the plugin's fine-grained adapter. That is fine
// here because docs render at build time (scripts/prerender-docs.ts) — the
// Worker bundle never sees this import.
async function highlightDocsCode(code: string, lang?: string): Promise<string> {
  const normalizedLang = lang?.trim() || DEFAULT_LANGUAGE
  // shiki has no `mermaid` grammar, so highlighting one would silently fall
  // back to `text` and render the diagram source as a grey code block. Hand
  // it to the client instead, in the same `<pre class="mermaid">` shape the
  // framework's own docs viewer uses (`guren docs:graph`).
  if (normalizedLang === 'mermaid') {
    return `<pre class="mermaid">${escapeHtml(code)}</pre>`
  }
  try {
    return await codeToHtml(code, { lang: normalizedLang, themes: MARKDOWN_CODE_THEMES, defaultColor: 'light' })
  } catch {
    return await codeToHtml(code, { lang: DEFAULT_LANGUAGE, themes: MARKDOWN_CODE_THEMES, defaultColor: 'light' })
  }
}

export async function renderMarkdownToHtml(
  markdown: string,
  linkContext?: DocLinkContext,
): Promise<string> {
  // A renderer per call binds the link context; render() itself keeps its
  // heading-slug state per render, so concurrent requests stay isolated.
  const renderer = createMarkdownRenderer({
    // Trusted repo content, rendered at build time — the sanitizer would
    // only strip the raw HTML some docs legitimately embed.
    sanitize: false,
    alertLabels: SITE_ALERT_LABELS,
    rewriteLink: linkContext ? (href) => rewriteDocLink(href, linkContext) : undefined,
    rewriteImage: linkContext ? (src) => rewriteDocImage(src, linkContext) : undefined,
    highlight: highlightDocsCode,
  })
  return renderer.render(markdown)
}
