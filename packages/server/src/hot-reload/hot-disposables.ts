/**
 * Stops the timers a previous module evaluation left running: `bun --hot`
 * re-runs the module graph in-process and a `setInterval` callback keeps its
 * owner reachable, so each reload leaks a timer and the dead graph behind it.
 * Teardown is parked on `globalThis`, which survives re-evaluation — Bun
 * exposes no `import.meta.hot` to `bun --hot` (1.3.14). Owners are keyed on
 * file + discriminator, never line: a line moves whenever anything above it
 * does. Twin of `packages/orm/src/active-connections.ts` — the frame-walk rule
 * is the same in both and must be carried across by hand.
 */

import { matchingOpenParen } from '../support/stack-frames'

type Dispose = () => void

/** Frees the slot an owner claimed, unless a newer owner has since taken it. */
export interface HotDisposableClaim {
  release(): void
}

const REGISTRY_KEY = Symbol.for('guren.server.hotDisposables')

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, Dispose>
}

function getRegistry(): Map<string, Dispose> {
  const scope = globalThis as GlobalWithRegistry
  return (scope[REGISTRY_KEY] ??= new Map<string, Dispose>())
}

/**
 * Whether modules can be re-evaluated in this process. `bun --watch` restarts
 * instead, dropping every timer with it, so `--hot` is the only mode that leaks.
 * Exported so callers can skip building the `Error` whose stack identifies them
 * — capturing one formats the whole stack into a string.
 */
export function isHotReloadRuntime(): boolean {
  return typeof process !== 'undefined' && Array.isArray(process.execArgv) && process.execArgv.includes('--hot')
}

/**
 * Paths the engine reports for code with no source location — JSC emits
 * `at new Owner (unknown:1:28)` for an implicit constructor, and
 * `at map (native:1:11)` for a built-in. Taking one would key every such owner
 * in the process to the same slot, where each new one stops the last.
 */
const SYNTHETIC_FRAME_PATHS = new Set(['unknown', 'native', '<anonymous>'])

const LOCATION_SUFFIX = /:\d+(?::\d+)?$/

/** Both match one character, so neither can backtrack the way `\s*` in a pattern can. */
const WHITESPACE = /\s/
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

/**
 * What a bare `at …` frame carries, with surrounding whitespace dropped.
 * Scanned rather than captured with `/^\s*at\s+(.+?)\s*$/`, whose lazy body and
 * greedy tail contend for the same spaces: a padded frame took time cubic in
 * the padding's length before concluding it did not match.
 */
function parseBareFrame(frame: string): string | undefined {
  const end = frame.trimEnd().length

  let cursor = 0
  while (cursor < end && WHITESPACE.test(frame[cursor])) cursor += 1
  if (!frame.startsWith('at', cursor)) return undefined

  const afterAt = cursor + 2
  let start = afterAt
  while (start < end && WHITESPACE.test(frame[start])) start += 1
  if (start === afterAt) return undefined

  // A frame body never spans a line break, so one that does is no body at all.
  const body = frame.slice(start, end)

  return LINE_TERMINATOR.test(body) ? undefined : body
}

/**
 * The text inside the parentheses that close a frame. Which `(` opens them is
 * `matchingOpenParen`'s problem: both the path and the function name in front
 * of it may contain parentheses.
 */
function parenthesizedLocation(frame: string): string | undefined {
  const trimmed = frame.trimEnd()

  if (!trimmed.endsWith(')')) {
    return undefined
  }

  const open = matchingOpenParen(trimmed, trimmed.length - 1)

  return open === undefined ? undefined : trimmed.slice(open + 1, -1)
}

/**
 * The path a single stack frame points at, without its line and column. The
 * parenthesized shape is read first because its parentheses bound the path; the
 * bare shape falls back to whitespace, which truncates `/Users/me/My
 * Projects/app.ts`. The trailing `:line` proves this is a location at all, and
 * an `eval` group is rejected — an owner with no key is left alone, safely.
 */
function parseFrameLocation(frame: string): string | undefined {
  const location = parenthesizedLocation(frame) ?? parseBareFrame(frame)

  if (!location || location.startsWith('eval at ') || !LOCATION_SUFFIX.test(location)) {
    return undefined
  }

  return location.replace(LOCATION_SUFFIX, '')
}

/**
 * The file that built the timer owner. `stack` must come from an `Error`
 * constructed inside the constructor or factory itself, so frame 2 is the
 * caller — or the first frame after it naming a real file, since the engine may
 * have synthesized the ones in between.
 */
export function describeCallerFile(stack: string | undefined): string | undefined {
  for (const frame of stack?.split('\n').slice(2) ?? []) {
    const path = parseFrameLocation(frame)

    if (path && !SYNTHETIC_FRAME_PATHS.has(path)) {
      return path
    }
  }

  return undefined
}

/**
 * Identity for a timer owner across hot reloads, or `undefined` when the owner
 * must be left alone. `target` separates owners sharing a call site, so one
 * module building several does not collapse them into a single slot.
 */
export function hotReloadKey(scope: string, stack: string | undefined, target: string): string | undefined {
  if (!isHotReloadRuntime()) {
    return undefined
  }

  const callerFile = describeCallerFile(stack)

  return callerFile ? `${scope}|${callerFile}|${target}` : undefined
}

/**
 * Records `dispose` as the live owner for this identity, stops whichever owner
 * held it before, and returns the claim. `undefined` outside `--hot`, or when
 * the stack names no caller — the owner is then left alone. A teardown that
 * throws is reported and swallowed, since refusing to register the replacement
 * would leak the very timer this exists to stop.
 */
export function claimHotDisposable(
  scope: string,
  stack: string | undefined,
  target: string,
  dispose: Dispose,
): HotDisposableClaim | undefined {
  const key = hotReloadKey(scope, stack, target)
  if (!key) {
    return undefined
  }

  const registry = getRegistry()
  const previous = registry.get(key)

  // Vacated before the old teardown runs: a teardown may claim this identity
  // again on its way out, and with the new owner already installed that nested
  // claim would stop a timer just created. Left empty, the worst it can do is
  // strand one.
  registry.delete(key)

  if (previous && previous !== dispose) {
    try {
      previous()
    } catch (error) {
      console.warn('[guren] Failed to stop the previous hot-reload disposable:', error)
    }
  }

  registry.set(key, dispose)

  return {
    release() {
      if (registry.get(key) === dispose) {
        registry.delete(key)
      }
    },
  }
}
