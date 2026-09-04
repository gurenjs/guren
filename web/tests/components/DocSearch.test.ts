import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * A source-level check, the only kind available: `web` has no DOM test
 * harness, and the failure this pins passes every other gate. The dialog
 * cannot render where the trigger sits: `.docs-sidebar` is `position: sticky`,
 * which creates a stacking context, so `z-50` there orders the dialog only
 * within the sidebar and `.docs-content pre` (position: relative) paints over it.
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

  it('lets the IME keep the keys it needs', () => {
    // Converting 「にんしょう」to 「認証」ends with Enter, and that Enter
    // arrives at keydown like any other — the dialog took it as "open the
    // selected result" and navigated away mid-word. The arrow keys move
    // through conversion candidates and Escape cancels the conversion, so
    // both handlers have to defer, not just the one that reads Enter.
    expect(source).toMatch(/function isImeKey/u)
    expect(source).toContain('event.nativeEvent.isComposing')
    expect(source).toMatch(/const onInputKeyDown[\s\S]{0,120}isImeKey\(event\)/u)
    expect(source).toMatch(/const onDialogKeyDown[\s\S]{0,120}isImeKey\(event\)/u)
  })

  it('does not search a reading the reader has not converted yet', () => {
    // Otherwise 「にんしょう」costs a request to report no matches for
    // something still being written.
    // The `={` matters: a substring check passes against `onCompositionEndX`.
    expect(source).toContain('onCompositionStart={')
    expect(source).toContain('onCompositionEnd={')
    expect(source).toMatch(/if \(!open \|\| composing\)/u)
  })

  it('keeps the sidebar reason next to the portal', () => {
    // The comment is the only thing that stops someone unwinding this as an
    // unnecessary indirection.
    expect(source).toMatch(/sticky creates a\s*\n\s*\/\/ stacking context/u)
  })
})
