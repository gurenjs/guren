import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCS_CACHE_CONTROL, docsBasePath } from '../../config/site.js'
import {
  DOC_FRAGMENT_ROOT,
  docFragmentPath,
  docMarkdownPath,
  LLMS_FULL_PATH,
} from '../../app/Services/docs-manifest.js'

const headers = readFileSync(resolve(import.meta.dirname, '../../public/_headers'), 'utf8')

// public/_headers is the one place these paths are spelled by hand. A renamed
// prefix has to fail here rather than silently drop noindex from the fragments.
describe('public/_headers', () => {
  it('should carry a rule for every prerendered docs path', () => {
    expect(headers).toContain(`\n${DOC_FRAGMENT_ROOT}/*\n`)
    expect(headers).toContain(`\n${docsBasePath('en')}/*.md\n`)
    expect(headers).toContain(`\n${LLMS_FULL_PATH}\n`)
  })

  it('should match the cache policy the Worker sets on the same content', () => {
    expect(headers).toContain(`  Cache-Control: ${DOCS_CACHE_CONTROL}\n`)
  })

  it('should cover the generated paths with those rules', () => {
    expect(docFragmentPath('ja', 'guides', 'routing').startsWith(`${DOC_FRAGMENT_ROOT}/`)).toBe(true)
    // The Japanese markdown lives under the English prefix, so one rule covers both.
    expect(docMarkdownPath('ja', 'guides', 'routing').startsWith(`${docsBasePath('en')}/`)).toBe(true)
  })
})
