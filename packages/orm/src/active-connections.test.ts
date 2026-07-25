import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { describeCallSite, hotReloadKey, releaseActiveConnection, replaceActiveConnection } from './active-connections'

function withHotRuntime<T>(callback: () => T): T {
  process.execArgv.push('--hot')
  try {
    return callback()
  } finally {
    process.execArgv.splice(process.execArgv.indexOf('--hot'), 1)
  }
}

describe('describeCallSite', () => {
  test('should return the frame that called the factory', () => {
    const stack = [
      'Error',
      '    at createPostgresDatabase (/app/node_modules/@guren/orm/dist/index.js:120:15)',
      '    at /app/config/database.ts:3:18',
      '    at /app/src/app.ts:9:1',
    ].join('\n')

    expect(describeCallSite(stack)).toBe('/app/config/database.ts:3:18')
  })

  test('should read a frame that carries a function name', () => {
    const stack = [
      'Error',
      '    at createSqliteDatabase (/app/dist/index.js:120:15)',
      '    at makeDatabase (/app/config/database.ts:12:20)',
    ].join('\n')

    expect(describeCallSite(stack)).toBe('/app/config/database.ts:12:20')
  })

  test('should return undefined when there is no caller frame', () => {
    expect(describeCallSite(undefined)).toBeUndefined()
    expect(describeCallSite('Error')).toBeUndefined()
    expect(describeCallSite('Error\n    at createPostgresDatabase (/app/dist/index.js:120:15)')).toBeUndefined()
  })

  test('should distinguish two call sites in the same file', () => {
    const at = (line: number) =>
      describeCallSite(`Error\n    at factory (/app/dist/index.js:1:1)\n    at /app/config/database.ts:${line}:18`)

    expect(at(3)).not.toBe(at(9))
  })

  test('should parse a stack this runtime actually produced', () => {
    // The fixtures above are hand-written, so they would keep passing if the
    // engine changed its stack format and every real key silently became
    // undefined — leaking again, quietly. This asserts against the real thing.
    const factory = () => describeCallSite(new Error().stack)
    const callers: (string | undefined)[] = []
    for (let i = 0; i < 2; i += 1) callers.push(factory())

    expect(callers[0]).toContain('active-connections.test.ts')
    // One call site repeated — what a hot reload reproduces — must stay stable.
    expect(callers[0]).toBe(callers[1])
    expect(factory()).not.toBe(callers[0])
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
        'postgres|/app/config/database.ts:3:18|postgres://example',
      )
    })
  })

  test('should return undefined when the call site cannot be determined', () => {
    withHotRuntime(() => {
      expect(hotReloadKey('postgres', undefined, 'postgres://example')).toBeUndefined()
    })
  })

  test('should separate factories written on different lines', () => {
    withHotRuntime(() => {
      const web = hotReloadKey('postgres', stack, 'postgres://example')
      const jobs = hotReloadKey(
        'postgres',
        'Error\n    at factory (/app/dist/index.js:1:1)\n    at /app/config/database.ts:9:18',
        'postgres://example',
      )

      expect(web).not.toBe(jobs)
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
