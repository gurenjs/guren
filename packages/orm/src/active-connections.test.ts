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
    // undefined — leaking again, quietly. This asserts against the real thing.
    const factory = () => describeCallerFile(new Error().stack)

    const here = factory()
    expect(here).toBeDefined()
    expect(here).toEndWith('active-connections.test.ts')
    // A call from a different line of this same file must produce the same key.
    expect(factory()).toBe(here)
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
