// Reassemble what prerender-docs.ts wrote under public/ into the shape the
// search index builder indexes. Driven by the manifest, not by a directory
// walk: a fragment on disk the manifest does not name is a leftover, not
// content, and must not reach the index.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { docsManifest } from '../../.guren/docs-manifest.gen.js'
import { docFragmentPath, type DocFragment } from '../../app/Services/docs-manifest.js'
import type { DocsByLocale } from '../../app/Services/search-index-build.js'

const publicDir = fileURLToPath(new URL('../../public', import.meta.url))

/** Null when the manifest is the stub a checkout without a real build carries. */
export function readPrerenderedDocs(): DocsByLocale | null {
  if (!docsManifest.prerendered) {
    return null
  }

  const docs: DocsByLocale = {}
  for (const [locale, categories] of Object.entries(docsManifest.docs)) {
    for (const [category, slugs] of Object.entries(categories)) {
      for (const slug of Object.keys(slugs)) {
        const file = resolve(publicDir, `.${docFragmentPath(locale, category, slug)}`)
        const fragment = JSON.parse(readFileSync(file, 'utf8')) as DocFragment
        ;((docs[locale] ??= {})[category] ??= {})[slug] = { title: fragment.title, html: fragment.html }
      }
    }
  }
  return docs
}
