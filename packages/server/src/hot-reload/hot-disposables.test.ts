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
    const stack = `Error\n    at new Base (/app/dist/index.js:1:1)\n    at a${' '.repeat(100_000)}a`
    const started = performance.now()

    expect(describeCallerFile(stack)).toBeUndefined()
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
