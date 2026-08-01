import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { describeCallerFile, hotReloadKey, releaseActiveConnection, replaceActiveConnection } from './active-connections'

function withHotRuntime<T>(callback: () => T): T {
  process.execArgv.push('--hot')
  try {
    return callback()
  } finally {
    process.execArgv.splice(process.execArgv.indexOf('--hot'), 1)
  }
}

describe('describeCallerFile', () => {
  test('should return the file that called the factory', () => {
    const stack = [
      'Error',
      '    at createPostgresDatabase (/app/node_modules/@guren/orm/dist/index.js:120:15)',
      '    at /app/config/database.ts:3:18',
      '    at /app/src/app.ts:9:1',
    ].join('\n')

    expect(describeCallerFile(stack)).toBe('/app/config/database.ts')
  })

  test('should read a frame that carries a function name', () => {
    const stack = [
      'Error',
      '    at createSqliteDatabase (/app/dist/index.js:120:15)',
      '    at makeDatabase (/app/config/database.ts:12:20)',
    ].join('\n')

    expect(describeCallerFile(stack)).toBe('/app/config/database.ts')
  })

  test('should read a frame that carries no column', () => {
    expect(describeCallerFile('Error\n    at factory (/app/dist/index.js:1:1)\n    at /app/config/database.ts:3')).toBe(
      '/app/config/database.ts',
    )
  })

  test('should keep a path that contains spaces intact', () => {
    // "My Projects", iCloud's "Mobile Documents" — ordinary on macOS. A
    // truncated path no longer identifies the caller: two call sites that
    // truncate alike land on one registry slot, and under `--hot` the second
    // would close the first's live connection.
    const bare = [
      'Error',
      '    at createPostgresDatabase (/app/dist/index.js:1:1)',
      '    at /Users/me/My Projects/app/config/database.ts:3:18',
    ].join('\n')
    const named = [
      'Error',
      '    at createPostgresDatabase (/app/dist/index.js:1:1)',
      '    at makeDatabase (/Users/me/My Projects/app/config/database.ts:3:18)',
    ].join('\n')

    expect(describeCallerFile(bare)).toBe('/Users/me/My Projects/app/config/database.ts')
    expect(describeCallerFile(named)).toBe('/Users/me/My Projects/app/config/database.ts')
  })

  test('should keep a path that contains parentheses intact', () => {
    // Same failure as the spaces above: the path is whatever the frame says it
    // is, so nothing about it may be excluded — a named frame is bounded by its
    // own trailing `)`, not by the first one it happens to contain.
    const bare = ['Error', '    at factory (/app/dist/index.js:1:1)', '    at /app (old)/config/database.ts:3:18'].join(
      '\n',
    )
    const named = [
      'Error',
      '    at factory (/app/dist/index.js:1:1)',
      '    at makeDatabase (/app (old)/config/database.ts:3:18)',
    ].join('\n')

    expect(describeCallerFile(bare)).toBe('/app (old)/config/database.ts')
    expect(describeCallerFile(named)).toBe('/app (old)/config/database.ts')
  })

  test('should reject a frame that names no location', () => {
    // Rejecting is the safe failure: no key means the handle is left alone, and
    // a leaked connection beats closing a live one that belongs to someone else.
    const frame = (last: string) => describeCallerFile(`Error\n    at factory (/app/dist/index.js:1:1)\n${last}`)

    expect(frame('    at native')).toBeUndefined()
    expect(frame('    at <anonymous>')).toBeUndefined()
    expect(frame('    at makeDatabase (native)')).toBeUndefined()
  })

  test('should return undefined when there is no caller frame', () => {
    expect(describeCallerFile(undefined)).toBeUndefined()
    expect(describeCallerFile('Error')).toBeUndefined()
    expect(describeCallerFile('Error\n    at createPostgresDatabase (/app/dist/index.js:120:15)')).toBeUndefined()
  })

  test('should split a path that itself ends in numbers at the leftmost location', () => {
    // `/app/v2:9` is a legal path followed by a line number, so `:1:2` has to
    // be read as line and column rather than the path keeping `:1` and the
    // column standing alone. Anything else keys two reloads of one file apart.
    const frame = (last: string) => describeCallerFile(`Error\n    at factory (/app/dist/index.js:1:1)\n${last}`)

    expect(frame('    at /app/v2:1:2')).toBe('/app/v2')
    expect(frame('    at a:1:2:3')).toBe('a:1')
    expect(frame('    at factory (/app/v2:1:2)')).toBe('/app/v2')
  })

  test('should read a malformed frame exactly as the engine-driven parse did', () => {
    // These are degenerate frames no runtime emits, pinned because the parse is
    // deliberately bug-for-bug with the pattern it replaced and nothing else
    // holds it there: each of these is the only witness that separates the
    // real rule from a plausible simplification of it. Their values are not
    // interesting in themselves — that they do not drift is.
    const frame = (last: string) => describeCallerFile(`Error\n    at factory (/app/dist/index.js:1:1)\n${last}`)

    // A path may be the whitespace the run after `at` gives back...
    expect(frame('at  :1')).toBe(' ')
    // ...but only where there is a spare character to give.
    expect(frame('at :1')).toBeUndefined()
    // Line and column are split off together, leaving `:1` as the path.
    expect(frame('at   :1:1')).toBe(':1')
  })

  test('should not take time superlinear in the length of a frame', () => {
    // Both shapes previously backtracked polynomially, so a frame padded with
    // whitespace or opening parens cost quadratic time. Nothing here is
    // request-derived, but a stack embeds whatever a message put in it.
    const padded = (last: string) => describeCallerFile(`Error\n    at factory (/app/dist/index.js:1:1)\n${last}`)
    const started = performance.now()

    expect(padded(`    at ${' '.repeat(100_000)}x`)).toBeUndefined()
    expect(padded(`    ${'('.repeat(100_000)}x`)).toBeUndefined()

    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test('should stay linear in the number of frames as well as their length', () => {
    // The two fixtures above put the adversarial frame last, so the walk exits
    // after one of them however slow that one is. Cost has to track the total
    // size of the stack, not the product of frame count and frame length — the
    // walk visits every frame, and each carries the shapes that used to
    // backtrack.
    const stack = (count: number, width: number) =>
      ['Error', '    at factory (/app/dist/index.js:1:1)', ...Array(count).fill(`    at ${' '.repeat(width)}x`)].join(
        '\n',
      )
    const time = (input: string) => {
      const started = performance.now()
      expect(describeCallerFile(input)).toBeUndefined()
      return performance.now() - started
    }

    // Same total bytes, opposite split between count and width. Quadratic in
    // either dimension would separate these two by orders of magnitude.
    const many = time(stack(100, 10_000))
    const long = time(stack(10, 100_000))

    expect(many).toBeLessThan(1_000)
    expect(long).toBeLessThan(1_000)
  })

  test('should stay identical when the call moves to another line', () => {
    // The whole point of dropping line and column: adding an import above the
    // factory must not orphan the entry holding the previous connection.
    const at = (line: number) =>
      describeCallerFile(`Error\n    at factory (/app/dist/index.js:1:1)\n    at /app/config/database.ts:${line}:18`)

    expect(at(3)).toBe(at(9))
    expect(at(3)).toBe('/app/config/database.ts')
  })

  test('should parse a stack this runtime actually produced', () => {
    // The fixtures above are hand-written, so they would keep passing if the
    // engine changed its stack format and every real key silently became
    // undefined — leaking again, quietly. This asserts against the real thing,
    // including through an implicit constructor: a field initializer needs no
    // explicit constructor and no subclass, so `class Database { db = create() }`
    // is enough for JSC to put an `unknown` frame where the caller belongs.
    const factory = () => describeCallerFile(new Error().stack)

    class BaseDb {
      caller = factory()
    }
    class AppDb extends BaseDb {}

    const here = factory()
    expect(here).toEndWith('active-connections.test.ts')
    // A call from a different line of this same file must produce the same key,
    // and so must one the engine reports two synthesized frames behind.
    expect(factory()).toBe(here)
    expect(new AppDb().caller).toBe(here)
  })

  test('should walk past a synthetic frame that carries a location', () => {
    // `unknown` and `native` parse as perfectly good paths — they carry a
    // `:line:column` like any other frame — so the location check above cannot
    // reject them. Reading one as the caller keys every handle behind an
    // implicit constructor to the literal string `unknown`, which is worse than
    // no key at all: unrelated files collapse into one slot, and under `--hot`
    // each new handle closes a live connection belonging to someone else.
    const frame = (...synthetic: string[]) =>
      describeCallerFile(
        ['Error', '    at factory (/app/dist/index.js:1:1)', ...synthetic, '    at /app/config/database.ts:3:18'].join(
          '\n',
        ),
      )

    expect(frame('    at new Sub (unknown:1:28)')).toBe('/app/config/database.ts')
    expect(frame('    at map (native:1:11)')).toBe('/app/config/database.ts')
    expect(frame('    at <anonymous>:1:1')).toBe('/app/config/database.ts')

    // Consecutive ones, which is what a base class holding a field initializer
    // plus a subclass of it produces — the shape the live test below builds.
    // Skipping a single frame would hand back `unknown` here.
    expect(frame('    at new BaseDb (unknown:1:17)', '    at new AppDb (unknown:1:28)')).toBe('/app/config/database.ts')
  })

  test('should return undefined when every frame is synthetic', () => {
    // Falling back to the safe failure rather than to the last synthetic path:
    // no key means the handle is left alone.
    expect(
      describeCallerFile(['Error', '    at factory (/app/dist/index.js:1:1)', '    at new Sub (unknown:1:28)'].join('\n')),
    ).toBeUndefined()
  })

  test('should walk past a host frame that names no location at all', () => {
    // `at replace (unknown)` — no `:line`, so the shape check rejects it rather
    // than the synthetic-path set. It is still a host frame, and the real caller
    // sits behind it: Bun emits exactly this for a callback a built-in invoked
    // (`'x'.replace(/x/, fn)`). Stopping here instead of stepping over would
    // read two callers in *different* files as one absent caller and leak both.
    const frame = (last: string) =>
      describeCallerFile(
        ['Error', '    at factory (/app/dist/index.js:1:1)', '    at replace (unknown)', last].join('\n'),
      )

    expect(frame('    at openA (/app/db/a.ts:3:48)')).toBe('/app/db/a.ts')
    expect(frame('    at openB (/app/db/b.ts:3:48)')).toBe('/app/db/b.ts')
  })
})

describe('hotReloadKey', () => {
  const stack = 'Error\n    at factory (/app/dist/index.js:1:1)\n    at /app/config/database.ts:3:18'

  test('should return undefined outside a hot-reloading runtime', () => {
    expect(hotReloadKey('postgres', stack, 'postgres://example')).toBeUndefined()
  })

  test('should key by call site under --hot', () => {
    withHotRuntime(() => {
      expect(hotReloadKey('postgres', stack, 'postgres://example')).toBe(
        'postgres|/app/config/database.ts|postgres://example',
      )
    })
  })

  test('should return undefined when the call site cannot be determined', () => {
    withHotRuntime(() => {
      expect(hotReloadKey('postgres', undefined, 'postgres://example')).toBeUndefined()
    })
  })

  test('should survive the factory call moving to another line', () => {
    withHotRuntime(() => {
      const before = hotReloadKey('postgres', stack, 'postgres://example')
      const afterEdit = hotReloadKey(
        'postgres',
        'Error\n    at factory (/app/dist/index.js:1:1)\n    at /app/config/database.ts:9:18',
        'postgres://example',
      )

      expect(before).toBe(afterEdit)
    })
  })

  test('should separate factories built in different modules', () => {
    withHotRuntime(() => {
      const primary = hotReloadKey('postgres', stack, 'postgres://example')
      const reporting = hotReloadKey(
        'postgres',
        'Error\n    at factory (/app/dist/index.js:1:1)\n    at /app/config/reporting-database.ts:3:18',
        'postgres://example',
      )

      expect(primary).not.toBe(reporting)
    })
  })

  test('should separate one call site that opens several databases', () => {
    withHotRuntime(() => {
      expect(hotReloadKey('postgres', stack, 'postgres://tenant-a')).not.toBe(
        hotReloadKey('postgres', stack, 'postgres://tenant-b'),
      )
    })
  })

  test('should separate drivers sharing a call site and target', () => {
    withHotRuntime(() => {
      expect(hotReloadKey('postgres', stack, 'x')).not.toBe(hotReloadKey('mysql', stack, 'x'))
    })
  })
})

describe('replaceActiveConnection', () => {
  let closed: string[]

  beforeEach(() => {
    closed = []
  })

  afterEach(() => {
    closed = []
  })

  test('should close the previous client when a key is claimed again', async () => {
    const key = 'postgres|/app/config/database.ts:3:18|replace'

    await replaceActiveConnection(key, async () => {
      closed.push('first')
    })
    await replaceActiveConnection(key, async () => {
      closed.push('second')
    })

    expect(closed).toEqual(['first'])
  })

  test('should not close anything for a key claimed the first time', async () => {
    await replaceActiveConnection('postgres|/app/config/database.ts:3:18|fresh', async () => {
      closed.push('first')
    })

    expect(closed).toEqual([])
  })

  test('should leave clients under other keys open', async () => {
    const kept = 'postgres|/app/config/database.ts:3:18|kept'
    const replaced = 'postgres|/app/config/database.ts:9:18|replaced'

    await replaceActiveConnection(kept, async () => {
      closed.push('kept')
    })
    await replaceActiveConnection(replaced, async () => {
      closed.push('replaced')
    })
    await replaceActiveConnection(replaced, async () => {
      closed.push('replacement')
    })

    expect(closed).toEqual(['replaced'])
  })

  test('should not close a client that re-registers itself', async () => {
    const key = 'postgres|/app/config/database.ts:3:18|idempotent'
    const teardown = async () => {
      closed.push('only')
    }

    await replaceActiveConnection(key, teardown)
    await replaceActiveConnection(key, teardown)

    expect(closed).toEqual([])
  })

  test('should give up on a teardown that never settles', async () => {
    const key = 'postgres|/app/config/database.ts:3:18|hanging'

    await replaceActiveConnection(key, () => new Promise<void>(() => {}))

    // A wedged socket must not keep the replacement client from being used, and
    // the replacement must still own the slot afterwards.
    await replaceActiveConnection(
      key,
      async () => {
        closed.push('second')
      },
      10,
    )
    await replaceActiveConnection(key, async () => {
      closed.push('third')
    })

    expect(closed).toEqual(['second'])
  })

  test('should keep the new client registered when the previous teardown throws', async () => {
    const key = 'postgres|/app/config/database.ts:3:18|throwing'

    await replaceActiveConnection(key, async () => {
      throw new Error('connection already gone')
    })
    await replaceActiveConnection(key, async () => {
      closed.push('second')
    })
    await replaceActiveConnection(key, async () => {
      closed.push('third')
    })

    expect(closed).toEqual(['second'])
  })
})

describe('releaseActiveConnection', () => {
  test('should free the slot so the next claim closes nothing', async () => {
    const key = 'postgres|/app/config/database.ts:3:18|release'
    const closed: string[] = []
    const teardown = async () => {
      closed.push('first')
    }

    await replaceActiveConnection(key, teardown)
    releaseActiveConnection(key, teardown)
    await replaceActiveConnection(key, async () => {
      closed.push('second')
    })

    expect(closed).toEqual([])
  })

  test('should ignore a stale teardown that no longer holds the slot', async () => {
    const key = 'postgres|/app/config/database.ts:3:18|stale'
    const closed: string[] = []
    const stale = async () => {
      closed.push('stale')
    }
    const current = async () => {
      closed.push('current')
    }

    await replaceActiveConnection(key, stale)
    await replaceActiveConnection(key, current)
    // The replaced client deregisters itself while closing; the newer client
    // must keep the slot.
    releaseActiveConnection(key, stale)

    await replaceActiveConnection(key, async () => {
      closed.push('next')
    })

    expect(closed).toEqual(['stale', 'current'])
  })
})
