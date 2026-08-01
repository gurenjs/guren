/**
 * Which `(` opens the parenthesized location group at the end of a stack frame.
 *
 * That one question is all the package's two frame readers agree on — the debug
 * error page's `parseStackTrace` and the hot-reload registry's
 * `parseFrameLocation`. Everything after it differs on purpose: peeling
 * `:line[:column]` off the right (the page requires a column and keeps the
 * function name; the registry accepts a bare `:line`), and deciding which
 * locations are worth keeping at all (the registry rejects `eval` groups and
 * synthetic paths, because keying an owner on text that is not a path is worse
 * than not keying it; the page is happy to display whatever it was handed).
 * Keep every parenthesis fix here so those two cannot drift.
 *
 * A third reader, `packages/orm/src/active-connections.ts`, carries a copy of
 * the function below whose *body* is identical character for character; only
 * the prose around it differs, to speak about connections rather than frames.
 * That package must not import this one, so the two are kept in step by hand —
 * fix both, or neither.
 */

const OPEN_PAREN = 0x28
const CLOSE_PAREN = 0x29

/** The characters a stack frame can never span, so a scan stops at them. */
function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029
}

/**
 * The index of the `(` that matches the `)` at `closeIndex`, or `undefined`
 * when the frame carries no usable `(` at all.
 *
 * `closeIndex` is a parameter rather than derived here because each caller
 * already knows where its frame ends and gets there differently — two trim a
 * copy of the frame, the ORM's twin keeps an `end` offset to avoid allocating
 * one. It must point at the frame's final `)`; anything else is rejected.
 *
 * Neither the leftmost nor the rightmost `(` is right in general. A path may
 * contain one — `at fn (/app (old)/x.ts:1:2)` needs the outer, *leftmost* pair
 * — and so may the function name in front of it — `at weird (name)
 * (/app/x.ts:1:2)` needs the outer, *rightmost* pair. Depth is what actually
 * tells the two apart; a fixed "first" or "last" gets one of them wrong, and a
 * frame carrying both — `at weird (name) (/app (old)/x.ts:1:2)`, which is one
 * developer's checkout directory away from ordinary — is misread by either.
 *
 * A scan is also the only form that stays linear. Lazily matching from the
 * leftmost `(` retries the whole suffix at every parenthesis, which is
 * quadratic on a frame carrying many unmatched ones. Characters are compared by
 * code rather than tested against a pattern for the same reason the patterns
 * went: this loop runs over every character of every frame, and the one input
 * whose length nothing bounds is a frame — an error message can embed
 * request-derived text, and a continuation line of one that starts `at ` and
 * ends `)` is scanned in full.
 *
 * Depth alone would reject a frame whose location holds an *unmatched* `)`, as
 * `/app/name).ts` or a URL ending `?label=)` does — the scan runs off the front
 * still owing a paren, and the frame is dropped rather than displayed. So the
 * leftmost `(` the scan passed is kept as a fallback for exactly that case.
 * Only frames the depth rule rejects outright can reach it, so it is never
 * worse than depth alone, and it is the reading that keeps such a path whole.
 *
 * The scan stops at a line terminator: a path could never span one, so neither
 * a balanced `(` nor the fallback may come from the far side of a break.
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
