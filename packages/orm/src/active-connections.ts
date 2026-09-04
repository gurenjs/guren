/**
 * Closes the database client a previous module evaluation left open.
 *
 * `bun --hot` re-runs the module graph in-process: a `create*Database()`
 * factory's cached client resets but its connection leaks, one per reload.
 * Bun exposes no `import.meta.hot` under `--hot` (checked on 1.3.14), so the
 * teardown is parked on `globalThis`, which survives re-evaluation. Handles are
 * keyed by caller file + target, not line, so two handles built in one file
 * against one database share a key; give them separate modules.
 */

type Teardown = () => Promise<void> | void

interface ActiveConnection {
  teardown: Teardown
  /** Resolves once this claim has finished closing the client it replaced. */
  settled: Promise<void>
}

const REGISTRY_KEY = Symbol.for('guren.orm.activeConnections')

/**
 * Awaiting the teardown is the back-pressure that keeps a burst of reloads from
 * stacking up connections, but it runs on the path to the first query after a
 * reload, so a socket that never finishes closing must not wedge the dev server.
 */
const TEARDOWN_TIMEOUT_MS = 5_000

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, ActiveConnection>
}

function getRegistry(): Map<string, ActiveConnection> {
  const scope = globalThis as GlobalWithRegistry
  const existing = scope[REGISTRY_KEY]

  if (existing) {
    return existing
  }

  const registry = new Map<string, ActiveConnection>()
  scope[REGISTRY_KEY] = registry
  return registry
}

/** `bun --watch` restarts the process instead, so `--hot` is the only mode that leaks. */
function isHotReloadRuntime(): boolean {
  return typeof process !== 'undefined' && Array.isArray(process.execArgv) && process.execArgv.includes('--hot')
}

/** Both match one character, so neither can backtrack the way `\s*` in a pattern can. */
const WHITESPACE = /\s/
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

const OPEN_PAREN = 0x28
const CLOSE_PAREN = 0x29

/** The characters a stack frame can never span, so a scan stops at them. */
function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029
}

function isDigitAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  return code >= 48 && code <= 57
}

/**
 * Where a frame's trailing `:line[:column]` may begin, `:line:column` split
 * first, in the order the lazy `(.+?):\d+(?::\d+)?` this replaces settled on
 * them. Walking the digits back from `end` finds both in one pass; the pattern
 * re-tested the suffix at every prefix length, which made it quadratic.
 */
function locationSplits(frame: string, end: number): number[] {
  let cursor = end
  while (cursor > 0 && isDigitAt(frame, cursor - 1)) cursor -= 1
  if (cursor === end || cursor === 0 || frame[cursor - 1] !== ':') return []

  const lastColon = cursor - 1
  cursor = lastColon
  while (cursor > 0 && isDigitAt(frame, cursor - 1)) cursor -= 1

  return cursor < lastColon && cursor > 0 && frame[cursor - 1] === ':' ? [cursor - 1, lastColon] : [lastColon]
}

/** The path a split leaves in front of it, or undefined when it leaves none. */
function pathBefore(frame: string, from: number, splits: number[]): string | undefined {
  for (const split of splits) {
    if (split > from) return frame.slice(from, split)
  }
  return undefined
}

/**
 * The index of the `(` matching the final `)` at `closeIndex`. Both a path and
 * the function name in front of it may contain `(`, so only depth tells the
 * outer pair apart; the leftmost `(` passed is the fallback for a location
 * holding an unmatched `)`. Compared by code: this runs over every character of
 * every frame. Twin of `packages/server/src/support/stack-frames.ts` — keep in step.
 */
function matchingOpenParen(frame: string, closeIndex: number): number | undefined {
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

/**
 * The path a single stack frame points at, without its line and column.
 * `at fn (/path/file.ts:1:2)` is tried first because its parens bound the path;
 * a whitespace-bounded rule would truncate `/Users/me/My Projects/app`. Both
 * shapes require a trailing `:line`, and a V8 `eval at ...` group is rejected:
 * keying on text that is not a path is worse than leaving the handle unkeyed.
 */
function parseFrameLocation(frame: string): string | undefined {
  const end = frame.trimEnd().length

  if (end > 0 && frame[end - 1] === ')') {
    const splits = locationSplits(frame, end - 1)
    const open = splits.length === 0 ? undefined : matchingOpenParen(frame, end - 1)
    const path = open === undefined ? undefined : pathBefore(frame, open + 1, splits)

    if (path !== undefined && !path.startsWith('eval at ')) return path
  }

  // `at /path/file.ts:1:2`, where only the trailing location bounds the path.
  let cursor = 0
  while (cursor < end && WHITESPACE.test(frame[cursor])) cursor += 1
  if (!frame.startsWith('at', cursor)) return undefined

  const afterAt = cursor + 2
  let pathStart = afterAt
  while (pathStart < end && WHITESPACE.test(frame[pathStart])) pathStart += 1
  if (pathStart === afterAt) return undefined

  const splits = locationSplits(frame, end)
  if (splits.length === 0) return undefined

  // `at` is followed by a greedy run of whitespace, so the path starts as late
  // as that run allows while still leaving itself a character to match.
  pathStart = Math.min(pathStart, splits[splits.length - 1] - 1)
  if (pathStart <= afterAt) return undefined

  // Nothing can start this shape's path later, so a line break inside it means
  // there was never a match.
  const path = pathBefore(frame, pathStart, splits)

  return path !== undefined && !LINE_TERMINATOR.test(path) ? path : undefined
}

/**
 * Paths the engine reports for code with no source location — a class field
 * initializer as `at new Owner (unknown:1:17)`, a built-in caller as
 * `at map (native:1:11)`. Both carry a `:line`, so they parse as ordinary paths
 * and only this set rejects them. Twin in
 * `packages/server/src/hot-reload/hot-disposables.ts` — keep the two in step.
 */
const SYNTHETIC_FRAME_PATHS = new Set(['unknown', 'native', '<anonymous>'])

/**
 * The file that called a `create*Database()` factory. `stack` must come from an
 * `Error` constructed inside the factory: frame 0 is `Error`, 1 the factory, 2
 * the caller — or the first later frame naming a real file. A class field
 * initializer leaves no frame of its own, so a handle built there keys to
 * wherever `new` was written instead.
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
 * Identity for a database handle across hot reloads, or `undefined` when the
 * handle must be left alone.
 */
export function hotReloadKey(driver: string, stack: string | undefined, target: string): string | undefined {
  if (!isHotReloadRuntime()) {
    return undefined
  }

  const callerFile = describeCallerFile(stack)
  if (!callerFile) {
    return undefined
  }

  // The target is part of the key so one module opening a database per tenant
  // does not collapse them all into a single slot.
  return `${driver}|${callerFile}|${target}`
}

async function closeWithTimeout(teardown: Teardown, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      Promise.resolve(teardown()),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(() => {
          console.warn(
            `[guren/orm] The previous database connection did not close within ${timeoutMs}ms; continuing without it.`,
          )
          resolveTimeout()
        }, timeoutMs)
      }),
    ])
  } catch (error) {
    console.warn('[guren/orm] Failed to close the previous database connection:', error)
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * Records `teardown` as the active client for `key` and closes whichever client
 * held the slot before it. Claims on one key are serialized: without that, three
 * reloads inside the teardown window let the third close the second's client
 * mid-initialization, handing its caller an already-closed one. `timeoutMs` is
 * for tests; callers should leave it at the default.
 */
export async function replaceActiveConnection(
  key: string,
  teardown: Teardown,
  timeoutMs: number = TEARDOWN_TIMEOUT_MS,
): Promise<void> {
  const registry = getRegistry()
  const previous = registry.get(key)

  if (previous?.teardown === teardown) {
    return
  }

  const settled = (async () => {
    if (!previous) {
      return
    }

    await previous.settled.catch(() => {})
    await closeWithTimeout(previous.teardown, timeoutMs)
  })()

  registry.set(key, { teardown, settled })
  await settled
}

/**
 * Frees the slot held by `teardown`, unless a newer client already took it.
 */
export function releaseActiveConnection(key: string, teardown: Teardown): void {
  const registry = getRegistry()

  if (registry.get(key)?.teardown === teardown) {
    registry.delete(key)
  }
}
