/**
 * Stops the timers a previous module evaluation left running.
 *
 * `bun --hot` re-runs the module graph inside the same process. Anything the
 * previous evaluation built is dropped on the floor — but a `setInterval`
 * callback keeps its owner reachable, so a store, manager, or scheduler that
 * nothing references any more goes on firing forever. One extra timer per
 * reload, each one retaining the dead object graph behind it.
 *
 * `globalThis` survives re-evaluation, so it is where the previous owner's
 * teardown is parked — the same storage `Application.listen()` uses for the Bun
 * and Vite dev servers, and the same approach `@guren/orm` uses for database
 * connections. Bun does not expose `import.meta.hot` to `bun --hot` (checked on
 * 1.3.14), so there is no reload hook to register with instead.
 *
 * This is deliberately not the ORM's registry with the names changed. Closing a
 * connection is an async operation that can hang on a wedged socket, which is
 * what forces that module's serialized claims and teardown timeout. Every
 * teardown here is synchronous — `clearInterval`, and the `destroy()`/`stop()`
 * methods wrapping it — so a claim can simply run the previous teardown inline
 * and be done. Sharing a helper across the two packages would mean either a new
 * package for ~60 lines or a dependency `@guren/orm` is not allowed to take, and
 * would buy machinery neither side needs in the same shape.
 *
 * Its twin is `packages/orm/src/active-connections.ts`. `parseFrameLocation` and
 * the scan under it are the same rule in both, deliberately — a fix to one is
 * worth carrying to the other. `describeCallerFile` differs on purpose: the
 * owners here are constructed, so this side walks past synthetic frames.
 *
 * An owner is identified by the file that built it plus a discriminator, so it
 * is replaced only by a later evaluation of that same file. Keying on the exact
 * line would be more precise, but a line number changes the moment anything
 * above it does — adding an import would orphan the previous entry and leak the
 * timer it was holding, during the very workflow this exists to fix. The file is
 * stable across every edit that isn't a rename.
 */

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
 * Whether modules can be re-evaluated in this process.
 *
 * `bun --watch` restarts the process instead, which drops every timer with it,
 * so `--hot` is the only mode that leaks. Everywhere else — production, tests,
 * CLI commands, serverless — nothing is ever torn down automatically.
 *
 * Exported so callers can skip building the `Error` whose stack identifies them:
 * capturing one formats the whole stack into a string, and outside `--hot` it
 * would only be thrown away.
 */
export function isHotReloadRuntime(): boolean {
  return typeof process !== 'undefined' && Array.isArray(process.execArgv) && process.execArgv.includes('--hot')
}

/**
 * Paths the engine reports for code that has no source location.
 *
 * A class that extends another without declaring a constructor gets an implicit
 * one, and JSC reports it as `at new Subclass (unknown:1:28)` — a frame sitting
 * between the base constructor and the code that actually wrote `new`. Taking it
 * would key every such owner in the process to the string `unknown`, collapsing
 * owners built in different files into one slot where each new one stops the
 * last. `native` shows up the same way for built-ins (`at map (native:1:11)`).
 */
const SYNTHETIC_FRAME_PATHS = new Set(['unknown', 'native', '<anonymous>'])

const LOCATION_SUFFIX = /:\d+(?::\d+)?$/

/** Both match one character, so neither can backtrack the way `\s*` in a pattern can. */
const WHITESPACE = /\s/
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

/**
 * What a bare `at …` frame carries, with surrounding whitespace dropped.
 *
 * Scanned rather than captured with `/^\s*at\s+(.+?)\s*$/`, whose lazy body and
 * greedy tail both laid claim to the same spaces: a frame padded with a run of
 * them took time cubic in the run's length before concluding it did not match.
 *
 * One case is read differently on purpose. Where the frame is `at` and nothing
 * but whitespace, the pattern handed back a single space as the body; this
 * rejects it. The two agree at the only boundary that matters, because a body
 * carrying no `:line` is discarded by the caller either way.
 */
function parseBareFrame(frame: string): string | undefined {
  // `trimEnd` drops exactly the characters `\s` matches, so this is where the
  // pattern's trailing `\s*$` would have started.
  const end = frame.trimEnd().length

  let cursor = 0
  while (cursor < end && WHITESPACE.test(frame[cursor])) cursor += 1
  if (!frame.startsWith('at', cursor)) return undefined

  const afterAt = cursor + 2
  let start = afterAt
  while (start < end && WHITESPACE.test(frame[start])) start += 1
  if (start === afterAt) return undefined

  // A frame body never matched across a line break, so one spanning it is no
  // body at all. Nothing can start it later, so there is no second chance.
  const body = frame.slice(start, end)

  return LINE_TERMINATOR.test(body) ? undefined : body
}

/**
 * The text inside the parentheses that close a frame, or `undefined` when the
 * frame does not end in one.
 *
 * Scanned backwards from the final `)` counting depth, rather than matched.
 * Both the path and the function name may contain parentheses — `at fn (/app
 * (old)/x.ts:1:2)` and `at weird (name) (/app/x.ts:1:2)` are each ordinary — and
 * no single pattern separates them, because the first needs the leftmost `(`
 * and the second the rightmost. Depth is what actually distinguishes them.
 *
 * A scan is also the only form that stays linear. Lazily matching from the
 * leftmost `(` retries the whole suffix at every parenthesis, which is
 * quadratic on a frame carrying many unmatched ones.
 *
 * Bails if the scan crosses a line terminator before depth returns to zero: a
 * path could never span one, so an unbalanced `(` on the far side of a line
 * break was never part of this frame's location.
 */
function parenthesizedLocation(frame: string): string | undefined {
  const trimmed = frame.trimEnd()

  if (!trimmed.endsWith(')')) {
    return undefined
  }

  let depth = 0

  for (let index = trimmed.length - 1; index >= 0; index--) {
    const character = trimmed[index]

    if (LINE_TERMINATOR.test(character)) {
      return undefined
    }

    if (character === ')') {
      depth++
    } else if (character === '(' && --depth === 0) {
      return trimmed.slice(index + 1, -1)
    }
  }

  return undefined
}

/**
 * The path a single stack frame points at, without its line and column.
 *
 * The parenthesized shape is read first because its parentheses bound the path;
 * the bare `at /path/file.ts:1:2` can only be bounded by whitespace, which would
 * truncate `/Users/me/My Projects/app.ts` to `Projects/app.ts`. Nothing
 * constrains what the path may contain — spaces and parentheses are both
 * ordinary in a macOS directory name.
 *
 * The trailing `:line` is what proves this is a location at all rather than a
 * bare function name, so `at native` and `at <anonymous>` yield nothing. An
 * `eval` group is rejected outright: V8 nests the real location inside
 * `eval at fn (/app/x.ts:1:2), <anonymous>:1:1`, and keying an owner on text
 * that is not a path is worse than not keying it — an owner with no key is left
 * alone, which is the safe failure.
 */
function parseFrameLocation(frame: string): string | undefined {
  const location = parenthesizedLocation(frame) ?? parseBareFrame(frame)

  if (!location || location.startsWith('eval at ') || !LOCATION_SUFFIX.test(location)) {
    return undefined
  }

  return location.replace(LOCATION_SUFFIX, '')
}

/**
 * The file that built the timer owner.
 *
 * `stack` must come from an `Error` constructed inside the constructor or
 * factory itself, so frame 0 is `Error`, frame 1 is that function, and frame 2
 * is the caller — or the first frame after it that names a real file, since the
 * engine may have synthesized the frames in between. Only the path is kept: a
 * reload re-runs the same file, but not necessarily at the same line.
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
 * must be left alone.
 *
 * `target` separates owners that share a call site — the name of a cache store,
 * say — so one module building several does not collapse them into a slot where
 * each new one stops the last.
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
 * held it before, and hands back the claim so the new owner can give it up.
 *
 * Returns `undefined` outside `--hot`, or when the stack does not name a caller
 * — the owner is then simply left alone, which is how things behaved before this
 * registry existed.
 *
 * A teardown that throws is reported and swallowed: the replacement has already
 * been built by the time this runs, and refusing to register it would leak the
 * very timer this is here to stop.
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

  // The slot is vacated before the old teardown runs, not after. A teardown is
  // free to claim this identity again on its way out — the cache path runs a
  // store's own `destroy()`, and an application can put anything in one — and if
  // the new owner were already installed, that nested claim would read it as the
  // predecessor and stop a timer that had just been created. Leaving the slot
  // empty means the worst a nested claim can do is register something this call
  // then overwrites, which strands a timer rather than stopping a live one.
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
