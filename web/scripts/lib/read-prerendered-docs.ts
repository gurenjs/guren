// Reassemble what prerender-docs.ts wrote under public/ into the shape the
// search index builder indexes. Driven by the manifest, not by a directory
// walk: a fragment on disk the manifest does not name is a leftover, not
// content, and must not reach the index.
import { readFileSync } from 'node:fs'

import { docsManifest } from '../../.guren/docs-manifest.gen.js'
import { docFragmentPath, type DocFragment } from '../../app/Services/docs-manifest.js'
import type { DocsByLocale } from '../../app/Services/search-index-build.js'

import { publicFile } from './public-dir.js'

export function readPrerenderedDocs(): DocsByLocale {
  if (!docsManifest.prerendered) {
    throw new Error('Docs are not prerendered — run `bun run prerender` first.')
  }

  const docs: DocsByLocale = {}
  for (const [locale, categories] of Object.entries(docsManifest.docs)) {
    for (const [category, slugs] of Object.entries(categories)) {
      for (const slug of Object.keys(slugs)) {
        const fragment = JSON.parse(
          readFileSync(publicFile(docFragmentPath(locale, category, slug)), 'utf8'),
        ) as DocFragment
        ;((docs[locale] ??= {})[category] ??= {})[slug] = { title: fragment.title, html: fragment.html }
      }
    }
  }
  return docs
}
