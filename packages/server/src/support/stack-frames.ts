/**
 * Which `(` opens the location group at the end of a stack frame — the one
 * question the package's two frame readers share (the debug page's
 * `parseStackTrace` and the hot-reload registry's `parseFrameLocation`), so
 * every parenthesis fix belongs here and they cannot drift.
 *
 * `packages/orm/src/active-connections.ts` carries a character-identical copy
 * of the function below and must not import this one: fix both, or neither.
 */

const OPEN_PAREN = 0x28
const CLOSE_PAREN = 0x29

/** The characters a stack frame can never span, so a scan stops at them. */
function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029
}

/**
 * Depth, not a fixed "first" or "last": `at fn (/app (old)/x.ts:1:2)` needs the
 * leftmost pair, `at weird (name) (/app/x.ts:1:2)` the rightmost. The leftmost
 * `(` the scan passed is the fallback that saves a location carrying an
 * unmatched `)` (`/app/name).ts`). Scanning by char code stays linear where
 * lazy matching is quadratic, and nothing bounds a frame's length.
 */
export function matchingOpenParen(frame: string, closeIndex: number): number | undefined {
  if (frame.charCodeAt(closeIndex) !== CLOSE_PAREN) {
    return undefined
  }

  let depth = 0
  let leftmostOpen: number | undefined

  for (let index = closeIndex; index >= 0; index--) {
    const code = frame.charCodeAt(index)

    if (isLineTerminator(code)) {
      break
    }

    if (code === CLOSE_PAREN) {
      depth++
    } else if (code === OPEN_PAREN) {
      if (--depth === 0) {
        return index
      }
      leftmostOpen = index
    }
  }

  return leftmostOpen
}
