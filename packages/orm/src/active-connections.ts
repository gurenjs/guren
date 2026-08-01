/**
 * Closes the database client a previous module evaluation left open.
 *
 * `bun --hot` re-runs the module graph inside the same process. The cached
 * client each `create*Database()` factory keeps in closure state is reset along
 * with the module, but the connection that client opened stays alive with
 * nothing left holding a reference that could close it — one leaked connection
 * per reload until the server refuses new ones.
 *
 * `globalThis` survives re-evaluation, so it is where the previous client's
 * teardown is parked — the same storage `Application.listen()` uses for the Bun
 * and Vite dev servers. Bun does not expose `import.meta.hot` to `bun --hot`
 * (checked on 1.3.14), so there is no reload hook to register with instead.
 *
 * Only the storage carries over from `Application.listen()`, though, not its
 * simplicity: a process has exactly one Bun server, so `listen()` can replace
 * whatever it finds unconditionally. Connections have no such guarantee, so a
 * handle is identified by the file that built it and the database it points at.
 *
 * That pair is what survives an edit. Keying on the exact line would be more
 * precise, but a line number changes the moment anything above it does — adding
 * an import to `config/database.ts` would orphan the previous entry and leak the
 * connection it was holding, during the very workflow this exists to fix. The
 * file is stable across every edit that isn't a rename.
 *
 * The cost of that choice: two handles built in one file against one database —
 * separate pools for web requests and background jobs, say — share a key, so the
 * second replaces the first. Give them their own module to keep them apart. This
 * only runs under `--hot`, so the mistake surfaces immediately in dev rather
 * than anywhere it could reach production.
 */

type Teardown = () => Promise<void> | void

interface ActiveConnection {
  teardown: Teardown
  /** Resolves once this claim has finished closing the client it replaced. */
  settled: Promise<void>
}

const REGISTRY_KEY = Symbol.for('guren.orm.activeConnections')

/**
 * How long to wait for the previous client to close before giving up on it.
 *
 * The teardown is awaited so the replacement never runs alongside the client it
 * replaces — that back-pressure is what keeps a burst of reloads from stacking
 * up connections. But it runs on the path to the first query after a reload, so
 * a client whose socket never finishes closing must not wedge the dev server.
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

/**
 * Whether modules can be re-evaluated in this process.
 *
 * `bun --watch` restarts the process instead, which closes every connection on
 * its own, so `--hot` is the only mode that leaks. Everywhere else — production,
 * tests, CLI commands, serverless — nothing is ever torn down automatically.
 */
function isHotReloadRuntime(): boolean {
  return typeof process !== 'undefined' && Array.isArray(process.execArgv) && process.execArgv.includes('--hot')
}

/** Both match one character, so neither can backtrack the way `\s*` in a pattern can. */
const WHITESPACE = /\s/
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

function isDigitAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  return code >= 48 && code <= 57
}

function trimmedEnd(text: string): number {
  let cursor = text.length
  while (cursor > 0 && WHITESPACE.test(text[cursor - 1])) cursor -= 1
  return cursor
}

/**
 * Where a frame's trailing `:line[:column]` may begin, in the order the lazy
 * `(.+?):\d+(?::\d+)?` these replace settled on them: the `:line:column` split
 * first, because a lazy path stops at the earliest suffix that satisfies the
 * rest, then the `:column`-only split it backtracked to when the shorter path
 * came out empty.
 *
 * Walking the digits back from `end` finds both in one pass. The pattern
 * instead re-tested the suffix at every prefix length, which is what made it
 * quadratic in the length of a frame.
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
 * Where the last line terminator before `before` ends, or 0 when there is none.
 *
 * A path could never span one — the patterns spelled it `.`, which stops at
 * every line break — so this is the earliest a path ending at `before` may
 * start.
 */
function afterLastTerminator(frame: string, before: number): number {
  let cursor = before
  while (cursor > 0 && !LINE_TERMINATOR.test(frame[cursor - 1])) cursor -= 1
  return cursor
}

/**
 * The path a single stack frame points at, without its line and column.
 *
 * The two shapes a frame comes in are read separately rather than by one rule
 * loose enough to cover both. `at fn (/path/file.ts:1:2)` is tried first,
 * because its parentheses bound the path; a rule that also had to accept the
 * bare `at /path/file.ts:1:2` could only bound it by whitespace, and would
 * truncate `/Users/me/My Projects/app/config` to `Projects/app/config`.
 * Nothing constrains what the path itself may contain — spaces and parentheses
 * are both ordinary in a macOS directory name, and excluding either is how the
 * truncation happened in the first place.
 *
 * Both shapes require a trailing `:line`, so frames that name no location at
 * all — `at native`, `at <anonymous>` — are rejected instead of being read as a
 * path.
 */
function parseFrameLocation(frame: string | undefined): string | undefined {
  if (frame === undefined) return undefined

  const end = trimmedEnd(frame)

  // `at fn (/path/file.ts:1:2)`. The opening paren is the frame's *leftmost*
  // usable one, not the one nearest the location: `(` is ordinary in a
  // directory name, and matching leftmost is what keeps `/app (old)/config`
  // whole. Usable means the path it opens reaches the location without
  // crossing a line break, which is why a split can fall to a later paren.
  if (end > 0 && frame[end - 1] === ')') {
    let best: { open: number; split: number } | undefined

    for (const split of locationSplits(frame, end - 1)) {
      const open = frame.indexOf('(', Math.max(afterLastTerminator(frame, split) - 1, 0))
      if (open !== -1 && open + 1 < split && (best === undefined || open < best.open)) {
        best = { open, split }
      }
    }

    if (best !== undefined) return frame.slice(best.open + 1, best.split)
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

  // Nothing here can start the path any later, so a line break inside it means
  // there was never a match — unlike the parenthesized shape, whose opening
  // paren can move.
  const path = pathBefore(frame, pathStart, splits)

  return path !== undefined && !LINE_TERMINATOR.test(path) ? path : undefined
}

/**
 * The file that called a `create*Database()` factory.
 *
 * `stack` must come from an `Error` constructed inside the factory itself, so
 * frame 0 is `Error`, frame 1 is the factory, and frame 2 is the caller. Only
 * the path is kept: a reload re-runs the same file, but not necessarily at the
 * same line.
 */
export function describeCallerFile(stack: string | undefined): string | undefined {
  return parseFrameLocation(stack?.split('\n')[2])
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
 * held the slot before it.
 *
 * Claims on one key are serialized: a claim waits for the claim it supersedes to
 * finish its own replacement before tearing it down. Without that, three reloads
 * arriving inside the teardown window let the third close the second's client
 * while the second was still initializing, and the second would go on to hand
 * its caller a client that is already closed.
 *
 * `timeoutMs` exists so tests can exercise the give-up path without waiting out
 * the real budget; callers should leave it at the default.
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

    // Let the superseded claim finish before pulling its client out from under
    // it, then close it.
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
