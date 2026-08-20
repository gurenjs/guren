import { posix } from 'node:path'

import { codeToHtml } from 'shiki'

import { createMarkdownRenderer } from '@guren/plugin-markdown'

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

// Docs fences carry arbitrary languages, so this pipeline keeps the full
// shiki entry instead of the plugin's fine-grained adapter. That is fine
// here because docs render at build time (scripts/prerender-docs.ts) — the
// Worker bundle never sees this import.
async function highlightDocsCode(code: string, lang?: string): Promise<string> {
  const normalizedLang = lang?.trim() || DEFAULT_LANGUAGE
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
    highlight: highlightDocsCode,
  })
  return renderer.render(markdown)
}
