import { describe, expect, test } from 'bun:test'
import { claimHotDisposable, describeCallerFile, hotReloadKey } from './hot-disposables'
import { withHotRuntime } from './testing'

/** A stack shaped like the ones the four owners hand `claimHotDisposable`. */
function stackFrom(file: string, line = 31): string {
  return ['Error', '    at factory (/app/dist/index.js:1:1)', `    at ${file}:${line}:26`].join('\n')
}

describe('describeCallerFile', () => {
  test('should return the file that built the owner', () => {
    const stack = [
      'Error',
      '    at new BaseMemoryStore (/app/node_modules/@guren/server/dist/index.js:120:15)',
      '    at /app/routes/api.ts:31:26',
      '    at /app/src/app.ts:9:1',
    ].join('\n')

    expect(describeCallerFile(stack)).toBe('/app/routes/api.ts')
  })

  test('should read a frame that carries a function name', () => {
    const stack = [
      'Error',
      '    at createBroadcastManager (/app/dist/index.js:120:15)',
      '    at register (/app/app/Providers/BroadcastProvider.ts:10:29)',
    ].join('\n')

    expect(describeCallerFile(stack)).toBe('/app/app/Providers/BroadcastProvider.ts')
  })

  test('should read a frame that carries no column', () => {
    expect(describeCallerFile('Error\n    at factory (/app/dist/index.js:1:1)\n    at /app/routes/api.ts:31')).toBe(
      '/app/routes/api.ts',
    )
  })

  test('should keep a path that contains spaces intact', () => {
    // Ordinary on macOS. Splitting the frame on whitespace truncates this to
    // `Projects/app/routes/api.ts`, which collides with any other project whose
    // path ends the same way.
    const parenthesized = 'Error\n    at f (/app/dist/index.js:1:1)\n    at g (/Users/me/My Projects/app/api.ts:31:26)'
    const bare = 'Error\n    at f (/app/dist/index.js:1:1)\n    at /Users/me/My Projects/app/api.ts:31:26'

    expect(describeCallerFile(parenthesized)).toBe('/Users/me/My Projects/app/api.ts')
    expect(describeCallerFile(bare)).toBe('/Users/me/My Projects/app/api.ts')
  })

  test('should keep a path that contains parentheses intact', () => {
    // Also ordinary on macOS — a checkout under `~/Projects (2024)`. The path is
    // bounded by the `(` that matches the frame's final `)`, not by the first one
    // the path happens to contain.
    const parenthesized = 'Error\n    at f (/app/dist/index.js:1:1)\n    at g (/app (old)/routes/api.ts:31:26)'
    const bare = 'Error\n    at f (/app/dist/index.js:1:1)\n    at /app (old)/routes/api.ts:31:26'

    expect(describeCallerFile(parenthesized)).toBe('/app (old)/routes/api.ts')
    expect(describeCallerFile(bare)).toBe('/app (old)/routes/api.ts')
  })

  test('should key a path that contains an unmatched closing parenthesis', () => {
    // Nothing in the frame closes it, so counting depth alone runs off the front
    // and the frame is skipped — the walk then keys the owner on whichever
    // caller sits above it, collapsing every owner built through that caller
    // into one slot. The leftmost `(` is the reading that keeps the path whole.
    const stack = 'Error\n    at f (/app/dist/index.js:1:1)\n    at g (/app/name).ts:31:26)'

    expect(describeCallerFile(stack)).toBe('/app/name).ts')
  })

  test('should read past a function name that contains parentheses', () => {
    // Bun emits this for a method whose key carries parentheses:
    //   ({ 'weird (name)'() {} })['weird (name)']()
    // Taking the leftmost `(` yields `name) (/app/routes/api.ts`, which is not a
    // path but is stable enough to key an owner on.
    const stack = 'Error\n    at f (/app/dist/index.js:1:1)\n    at weird (name) (/app/routes/api.ts:31:26)'

    expect(describeCallerFile(stack)).toBe('/app/routes/api.ts')
  })

  test('should still see a synthetic frame through a parenthesized function name', () => {
    // The combination of the two cases above, and the reason the leftmost `(` is
    // not merely imprecise: `unknown` has to survive parsing intact or the filter
    // below never fires, and every such owner in the process shares one slot.
    const stack = [
      'Error',
      '    at new Base (/app/dist/index.js:120:15)',
      '    at new Derived (wrapped) (unknown:1:28)',
      '    at /app/routes/api.ts:31:26',
    ].join('\n')

    expect(describeCallerFile(stack)).toBe('/app/routes/api.ts')
  })

  test('should reject an eval frame rather than key an owner on it', () => {
    // V8 nests the real location inside the group. The text before `:1:1` is not
    // a path, and carries the outer line number, so it would drift on any edit.
    const stack =
      'Error\n    at f (/app/dist/index.js:1:1)\n    at eval (eval at <anonymous> (/app/x.ts:1:2), <anonymous>:1:1)'

    expect(describeCallerFile(stack)).toBeUndefined()
  })

  test('should step over the synthetic frame of an implicit constructor', () => {
    // A subclass with no constructor of its own gets an implicit one, which JSC
    // reports with no source location. Taking that frame keys every such owner
    // to the literal string `unknown`, so stores built in unrelated files share
    // a slot and stop each other.
    const stack = [
      'Error',
      '    at new BaseMemoryStore (/app/dist/index.js:120:15)',
      '    at new MemoryRateLimitStore (unknown:1:28)',
      '    at /app/routes/api.ts:31:26',
    ].join('\n')

    expect(describeCallerFile(stack)).toBe('/app/routes/api.ts')
  })

  test('should step over a run of frames with no source location', () => {
    const stack = [
      'Error',
      '    at new Base (/app/dist/index.js:120:15)',
      '    at new Middle (unknown:1:28)',
      '    at map (native:1:11)',
      '    at /app/routes/api.ts:31:26',
    ].join('\n')

    expect(describeCallerFile(stack)).toBe('/app/routes/api.ts')
  })

  test('should step over a group that leaves no path in front of the location', () => {
    // Degenerate — no engine emits these — but the twin in `@guren/orm` still
    // reads the first two as the path `:1`, because it keeps whatever its own
    // earlier pattern returned for a malformed frame. It can afford that: it
    // reads one frame and stops. This walks until a frame names a file, so any
    // non-empty string would end the walk and become a key, and a key two
    // unrelated files both land on is one where the second owner stops the
    // first's live timer. Pinned so that carrying the twin's parse across
    // wholesale — rather than by result — cannot quietly introduce it.
    const stepsOver = (frame: string) =>
      describeCallerFile(
        ['Error', '    at new Base (/app/dist/index.js:120:15)', frame, '    at /app/routes/api.ts:31:26'].join('\n'),
      )

    expect(stepsOver('    at fn (:1:2)')).toBe('/app/routes/api.ts')
    expect(stepsOver('    at fn ((:1:2)')).toBe('/app/routes/api.ts')
    expect(stepsOver('    at fn ()')).toBe('/app/routes/api.ts')
    // Ends in `)` while opening no group at all, so nothing bounds a path.
    expect(stepsOver('    at /app/x.ts:1:2)')).toBe('/app/routes/api.ts')
  })

  test('should ignore a frame that names a function but no location', () => {
    const stack = ['Error', '    at new Base (/app/dist/index.js:120:15)', '    at Object.<anonymous>'].join('\n')

    expect(describeCallerFile(stack)).toBeUndefined()
  })

  test('should return undefined when there is no caller frame', () => {
    expect(describeCallerFile(undefined)).toBeUndefined()
    expect(describeCallerFile('Error')).toBeUndefined()
    expect(describeCallerFile('Error\n    at new BaseMemoryStore (/app/dist/index.js:120:15)')).toBeUndefined()
  })

  test('should not take time superlinear in the length of a frame', () => {
    // The bare shape previously let a lazy body and a greedy whitespace tail
    // claim the same spaces. A run of them followed by anything that is not a
    // location made the two re-divide the run at every offset, so the cost grew
    // quadratically before the frame was finally rejected. The padding sits
    // *after* a non-space character on purpose: a frame that is only `at` plus
    // spaces matches on the first try and never reaches the slow path.
    const padded = (last: string) => describeCallerFile(`Error\n    at new Base (/app/dist/index.js:1:1)\n${last}`)
    const started = performance.now()

    expect(padded(`    at a${' '.repeat(100_000)}a`)).toBeUndefined()
    // The depth scan needs its own padding: the frame above does not end in `)`,
    // so it is rejected before reaching it. A run of unmatched `(` is what the
    // lazy match this replaced retried the whole suffix at, once per paren.
    expect(padded(`    at f (${'('.repeat(100_000)}x)`)).toBeUndefined()

    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test('should parse a stack this runtime actually produced', () => {
    // The fixtures above are hand-written, so they would keep passing if the
    // engine changed its stack format and every real key silently became
    // undefined — leaking again, quietly. This asserts against the real thing,
    // through an implicit constructor, which is the shape that broke first.
    class Base {
      readonly builtBy = describeCallerFile(new Error().stack)
    }
    class Derived extends Base {}

    const here = new Derived().builtBy
    expect(here).toEndWith('hot-disposables.test.ts')
    // A call from a different line of this same file must produce the same key.
    expect(new Derived().builtBy).toBe(here)
  })
})

describe('hotReloadKey', () => {
  const stack = stackFrom('/app/routes/api.ts')

  test('should return undefined outside a hot-reloading runtime', () => {
    expect(hotReloadKey('rate-limit-store', stack, 'MemoryRateLimitStore')).toBeUndefined()
  })

  test('should key by call site under --hot', () => {
    withHotRuntime(() => {
      expect(hotReloadKey('rate-limit-store', stack, 'MemoryRateLimitStore')).toBe(
        'rate-limit-store|/app/routes/api.ts|MemoryRateLimitStore',
      )
    })
  })

  test('should return undefined when the call site cannot be determined', () => {
    withHotRuntime(() => {
      expect(hotReloadKey('rate-limit-store', undefined, 'MemoryRateLimitStore')).toBeUndefined()
    })
  })

  test('should survive the call moving to another line', () => {
    // The whole point of dropping line and column: adding an import above the
    // call must not orphan the entry holding the previous timer.
    withHotRuntime(() => {
      expect(hotReloadKey('rate-limit-store', stack, 'X')).toBe(
        hotReloadKey('rate-limit-store', stackFrom('/app/routes/api.ts', 48), 'X'),
      )
    })
  })

  test('should separate owners built in different modules', () => {
    withHotRuntime(() => {
      expect(hotReloadKey('rate-limit-store', stack, 'X')).not.toBe(
        hotReloadKey('rate-limit-store', stackFrom('/app/routes/web.ts'), 'X'),
      )
    })
  })

  test('should separate one call site that builds several owners', () => {
    withHotRuntime(() => {
      expect(hotReloadKey('cache-store', stack, 'default')).not.toBe(hotReloadKey('cache-store', stack, 'sessions'))
    })
  })

  test('should separate scopes sharing a call site and target', () => {
    withHotRuntime(() => {
      expect(hotReloadKey('cache-store', stack, 'x')).not.toBe(hotReloadKey('scheduler', stack, 'x'))
    })
  })
})

describe('claimHotDisposable', () => {
  /** Claims `target` from a fixed synthetic call site, recording teardowns. */
  function claim(target: string, dispose: () => void, file = '/app/config/cache.ts') {
    return claimHotDisposable('cache-store', stackFrom(file), target, dispose)
  }

  test('should not claim anything outside a hot-reloading runtime', () => {
    const stopped: string[] = []

    expect(claim('inert', () => stopped.push('first'))).toBeUndefined()
    expect(claim('inert', () => stopped.push('second'))).toBeUndefined()
    expect(stopped).toEqual([])
  })

  test('should not claim anything when the call site cannot be determined', () => {
    withHotRuntime(() => {
      expect(claimHotDisposable('cache-store', 'Error', 'unparseable', () => {})).toBeUndefined()
    })
  })

  test('should stop the previous owner when an identity is claimed again', () => {
    withHotRuntime(() => {
      const stopped: string[] = []

      claim('replace', () => stopped.push('first'))
      claim('replace', () => stopped.push('second'))

      expect(stopped).toEqual(['first'])
    })
  })

  test('should reclaim an owner built under a directory whose name contains parens', () => {
    // The symptom rather than the parse behind it: while a named frame under
    // `Projects (old)` could not be read, this call no-opped and the previous
    // evaluation's interval went on firing — one leaked timer per reload for
    // anyone whose checkout sits in such a directory. The two claims use
    // different line numbers because a reload rarely leaves the call where it
    // was, and the key has to survive that.
    withHotRuntime(() => {
      const stopped: string[] = []
      const reloadAt = (line: number) =>
        [
          'Error',
          '    at new BaseMemoryStore (/app/dist/index.js:120:15)',
          `    at makeStore (/Users/me/Projects (old)/app/config/cache.ts:${line}:18)`,
        ].join('\n')

      claimHotDisposable('cache-store', reloadAt(3), 'store', () => stopped.push('first'))
      claimHotDisposable('cache-store', reloadAt(9), 'store', () => stopped.push('second'))

      expect(stopped).toEqual(['first'])
    })
  })

  test('should not stop anything for an identity claimed the first time', () => {
    withHotRuntime(() => {
      const stopped: string[] = []

      claim('fresh', () => stopped.push('first'))

      expect(stopped).toEqual([])
    })
  })

  test('should leave owners under other identities running', () => {
    withHotRuntime(() => {
      const stopped: string[] = []

      claim('kept', () => stopped.push('kept'))
      claim('replaced', () => stopped.push('replaced'))
      claim('replaced', () => stopped.push('replacement'))

      expect(stopped).toEqual(['replaced'])
    })
  })

  test('should not stop an owner that re-registers itself', () => {
    withHotRuntime(() => {
      const stopped: string[] = []
      const dispose = () => stopped.push('only')

      claim('idempotent', dispose)
      claim('idempotent', dispose)

      expect(stopped).toEqual([])
    })
  })

  test('should keep the new owner registered when the previous teardown throws', () => {
    withHotRuntime(() => {
      const stopped: string[] = []

      claim('throwing', () => {
        throw new Error('already gone')
      })
      claim('throwing', () => stopped.push('second'))
      claim('throwing', () => stopped.push('third'))

      expect(stopped).toEqual(['second'])
    })
  })

  test('should not let a teardown that re-claims the slot stop the new owner', () => {
    withHotRuntime(() => {
      const stopped: string[] = []

      // A store's own destroy() runs as the teardown here, and an application
      // can put anything in one — including something that resolves the store
      // again. The owner this call is installing must survive that.
      claim('reentrant', () => {
        stopped.push('first')
        claim('reentrant', () => stopped.push('nested'))
      })
      claim('reentrant', () => stopped.push('second'))

      expect(stopped).toEqual(['first'])

      claim('reentrant', () => stopped.push('third'))
      expect(stopped).toEqual(['first', 'second'])
    })
  })
})

describe('HotDisposableClaim.release', () => {
  test('should free the slot so the next claim stops nothing', () => {
    withHotRuntime(() => {
      const stopped: string[] = []
      const claim = claimHotDisposable('scheduler', stackFrom('/app/src/app.ts'), 'release', () =>
        stopped.push('first'),
      )

      claim?.release()
      claimHotDisposable('scheduler', stackFrom('/app/src/app.ts'), 'release', () => stopped.push('second'))

      expect(stopped).toEqual([])
    })
  })

  test('should ignore a release from an owner that no longer holds the slot', () => {
    withHotRuntime(() => {
      const stopped: string[] = []
      const stack = stackFrom('/app/src/app.ts')

      const stale = claimHotDisposable('scheduler', stack, 'stale', () => stopped.push('stale'))
      claimHotDisposable('scheduler', stack, 'stale', () => stopped.push('current'))
      // The replaced owner deregisters itself while stopping; the newer owner
      // must keep the slot.
      stale?.release()

      claimHotDisposable('scheduler', stack, 'stale', () => stopped.push('next'))

      expect(stopped).toEqual(['stale', 'current'])
    })
  })
})
