import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * A source-level check, which is not the kind this repo prefers — but it is
 * the kind available. `web` has no DOM test harness, and the failure it pins
 * is invisible to every other gate: the dialog renders, the tests pass, the
 * typecheck passes, and it is simply painted over on a page that has code
 * blocks.
 *
 * The rule: the dialog cannot render where the trigger sits. That trigger is
 * inside `.docs-sidebar`, which is `position: sticky`, and sticky creates a
 * stacking context — so `z-50` there orders the dialog only *within the
 * sidebar*, and `.docs-content pre` (position: relative, later in the
 * document) paints over it.
 */
const source = readFileSync(
  resolve(import.meta.dirname, '../../resources/js/components/DocSearch.tsx'),
  'utf8',
)

describe('DocSearch', () => {
  it('renders the dialog into the body rather than in place', () => {
    expect(source).toContain("import { createPortal } from 'react-dom'")
    expect(source).toMatch(/createPortal\(/u)
    expect(source).toContain('document.body,')
  })

  it('keeps the sidebar reason next to the portal', () => {
    // The comment is the only thing that stops someone unwinding this as an
    // unnecessary indirection.
    expect(source).toMatch(/sticky creates a\s*\n\s*\/\/ stacking context/u)
  })
})
