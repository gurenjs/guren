import { describe, expect, test } from 'bun:test'
import { matchingOpenParen } from './stack-frames'

/**
 * What the frame's location group would be, read through the index under test.
 * Both callers slice with it, so this is the property that matters — the index
 * itself is only meaningful next to the text on either side of it.
 */
function groupIn(frame: string): string | undefined {
  const open = matchingOpenParen(frame, frame.length - 1)
  return open === undefined ? undefined : frame.slice(open + 1, -1)
}

describe('matchingOpenParen', () => {
  test('should take the leftmost pair when the path contains parentheses', () => {
    // Ordinary on macOS — a checkout under `~/Projects (old)`.
    expect(groupIn('at fn (/app (old)/x.ts:1:2)')).toBe('/app (old)/x.ts:1:2')
  })

  test('should take the rightmost pair when the function name contains parentheses', () => {
    // A method whose key carries them: ({ 'weird (name)'() {} })['weird (name)']()
    expect(groupIn('at weird (name) (/app/x.ts:1:2)')).toBe('/app/x.ts:1:2')
  })

  test('should split a frame where both contain parentheses', () => {
    // The two cases above want opposite ends of the frame, so this one is
    // misread by any rule that picks a fixed end. Only depth gets it right.
    expect(groupIn('at weird (name) (/app (old)/x.ts:1:2)')).toBe('/app (old)/x.ts:1:2')
  })

  test('should fall back to the leftmost paren when the frame never balances', () => {
    // An unmatched `)` in the location — a directory named `name)`, or a URL
    // carrying one — leaves the depth scan owing a paren at the front. The
    // leftmost `(` is the reading that keeps such a location whole.
    expect(groupIn('at fn (/app/name).ts:1:2)')).toBe('/app/name).ts:1:2')
    expect(groupIn('at fn (file:///app/x.ts?label=):1:2)')).toBe('file:///app/x.ts?label=):1:2')
  })

  test('should return undefined when the frame carries no opening paren', () => {
    expect(groupIn('at fn /app/x.ts:1:2)')).toBeUndefined()
  })

  test('should reject an index that does not point at a closing paren', () => {
    // Both callers establish the trailing `)` themselves; a frame that ends any
    // other way has no group to find, and must not be read as if it had one.
    expect(matchingOpenParen('at fn (/app/x.ts:1:2', 19)).toBeUndefined()
  })

  test('should not reach a paren on the far side of a line terminator', () => {
    // U+2028 and U+2029 end a line without being `\n`, so a caller that split
    // on `\n` can still hand one over. Nothing beyond it may be read.
    expect(groupIn('at fn (/app/x.ts:1:2\u2028 tail)')).toBeUndefined()
    expect(groupIn('at fn (\u2029/app/x.ts:1:2)')).toBeUndefined()
  })

  test('should not take time superlinear in the length of a frame', () => {
    // A run of unmatched parens is what made lazy left-to-right matching
    // quadratic, and what drives this scan to the front — so the fallback
    // answers here.
    const frame = `at fn (/app/${')'.repeat(200_000)}x.ts:1:2)`
    const started = performance.now()

    expect(groupIn(frame)).toBe(frame.slice(frame.indexOf('(') + 1, -1))
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
