import { describe, it, expect, beforeEach, afterEach, setSystemTime, spyOn, type Mock } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runCommand } from 'citty'
import { consola } from 'consola'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { builtinSubCommands } from '../src/commands'
import {
  runToolLog,
  matchesFilters,
  parseSinceDuration,
  parseAuditLines,
  type ToolLogOptions,
} from '../src/tool-log'

/**
 * A *subdirectory* of the workspace, because `createTempWorkspace` chdirs into
 * the workspace it makes: an app at its root would leave `--app` and the cwd
 * equal, and every case would pass whether or not the flag was honoured.
 */
const APP_DIR_NAME = 'app'

/** Future-seeded, like the server-side fixtures: a past epoch expires everything. */
const TODAY = '2087-03-14'
const YESTERDAY = '2087-03-13'
const TOMORROW = '2087-03-15'

/**
 * Mirrors the command's own `FOLLOW_INTERVAL_MS`, copied rather than imported
 * so it stays out of the public surface. A larger real interval makes the waits
 * below time out by name rather than go wrong quietly.
 */
const FOLLOW_INTERVAL_MS = 500

/** Three bytes per character in UTF-8, so a read boundary can land inside one. */
const GREETING = 'こんにちは'

/** `count` consecutive date stamps, all older than {@link TODAY}. */
function stampsBefore(count: number): string[] {
  const start = Date.UTC(2086, 0, 1)
  return Array.from({ length: count }, (_unused, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10))
}

interface RecordOverrides {
  ts?: string
  tool?: string
  surface?: string
  outcome?: 'invoked' | 'denied'
  reason?: string
  status?: number
  args?: Record<string, unknown>
}

/** One line as the file sink writes it, log envelope and all. */
function line(overrides: RecordOverrides = {}): string {
  const outcome = overrides.outcome ?? 'invoked'
  const record = {
    ts: overrides.ts ?? `${TODAY}T12:00:00.000Z`,
    outcome,
    surface: overrides.surface ?? 'mcp',
    tool: overrides.tool ?? 'posts.index',
    principal: { kind: 'user', id: 42 },
    arguments: overrides.args ?? { page: 1 },
    ...(outcome === 'denied'
      ? { reason: overrides.reason ?? 'scope' }
      : { status: overrides.status ?? 200, durationMs: 7 }),
  }
  // The envelope `DailyFileChannel`'s JSON format adds: tolerating it is what
  // keeps the sink able to reuse the channel.
  return JSON.stringify({ timestamp: record.ts, level: 'info', message: 'agent.audit', ...record })
}

describe('guren tool:log', () => {
  let workspace: TempWorkspace
  let appDir: string
  let logDir: string
  let logSpy: Mock<typeof console.log>
  let errSpy: Mock<typeof console.error>
  let warnSpy: Mock<typeof consola.warn>
  let infoSpy: Mock<typeof consola.info>

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-tool-log-')
    appDir = join(workspace.dir, APP_DIR_NAME)
    logDir = join(appDir, 'storage', 'logs')
    await mkdir(logDir, { recursive: true })

    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    errSpy = spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = spyOn(consola, 'warn').mockImplementation((() => {}) as never)
    infoSpy = spyOn(consola, 'info').mockImplementation((() => {}) as never)
  })

  afterEach(async () => {
    logSpy.mockRestore()
    errSpy.mockRestore()
    warnSpy.mockRestore()
    infoSpy.mockRestore()
    await workspace.cleanup()
  })

  function logFile(stamp: string): string {
    return join(logDir, `agent-audit-${stamp}.log`)
  }

  async function seed(stamp: string, lines: string[]): Promise<void> {
    await writeFile(logFile(stamp), `${lines.join('\n')}\n`)
  }

  function printed(): string[] {
    return logSpy.mock.calls.map((call) => String(call[0]))
  }

  function tools(): string[] {
    return printed().map((row) => String(JSON.parse(row).tool))
  }

  function stderr(): string {
    return [...warnSpy.mock.calls, ...errSpy.mock.calls].flat().map(String).join('\n')
  }

  function info(): string {
    return infoSpy.mock.calls.flat().map(String).join('\n')
  }

  describe('reading the rotation set', () => {
    it('reads newest-first across two dated files and prints oldest-first', async () => {
      await seed(YESTERDAY, [
        line({ ts: `${YESTERDAY}T10:00:00.000Z`, tool: 'old.one' }),
        line({ ts: `${YESTERDAY}T11:00:00.000Z`, tool: 'old.two' }),
      ])
      await seed(TODAY, [line({ ts: `${TODAY}T09:00:00.000Z`, tool: 'new.one' })])

      await runToolLog({ appRoot: appDir, json: true })

      expect(printed().map((row) => JSON.parse(row).tool)).toEqual(['old.one', 'old.two', 'new.one'])
    })

    it('stops opening older files once the limit is met', async () => {
      await seed(YESTERDAY, [line({ tool: 'old.one' })])
      await seed(TODAY, [line({ tool: 'new.one' }), line({ tool: 'new.two' })])

      await runToolLog({ appRoot: appDir, limit: 2, json: true })

      expect(printed().map((row) => JSON.parse(row).tool)).toEqual(['new.one', 'new.two'])
    })

    it('ignores files that are not this base path’s', async () => {
      await seed(TODAY, [line({ tool: 'ours' })])
      await writeFile(join(logDir, `app-${TODAY}.log`), `${line({ tool: 'someone.elses' })}\n`)
      await writeFile(join(logDir, 'agent-audit.log'), `${line({ tool: 'undated' })}\n`)

      await runToolLog({ appRoot: appDir, json: true })

      expect(printed().map((row) => JSON.parse(row).tool)).toEqual(['ours'])
    })

    it('skips a truncated final line rather than failing the read', async () => {
      const complete = line({ tool: 'complete' })
      await writeFile(join(logDir, `agent-audit-${TODAY}.log`), `${complete}\n${complete.slice(0, 30)}`)

      await runToolLog({ appRoot: appDir, json: true })

      expect(printed()).toHaveLength(1)
    })

    it('honours --file over the default path', async () => {
      const elsewhere = join(appDir, 'var', 'trail.log')
      await mkdir(join(appDir, 'var'), { recursive: true })
      await writeFile(join(appDir, 'var', `trail-${TODAY}.log`), `${line({ tool: 'relocated' })}\n`)

      await runToolLog({ appRoot: appDir, file: elsewhere, json: true })

      expect(printed().map((row) => JSON.parse(row).tool)).toEqual(['relocated'])
    })
  })

  describe('filters', () => {
    beforeEach(async () => {
      await seed(TODAY, [
        line({ tool: 'posts.index', surface: 'mcp' }),
        line({ tool: 'posts.store', surface: 'mcp', outcome: 'denied', reason: 'scope' }),
        line({ tool: 'posts.index', surface: 'cli' }),
        line({ tool: 'posts.destroy', surface: 'webmcp', outcome: 'denied', reason: 'rate-limit' }),
      ])
    })

    it('filters by tool', async () => {
      await runToolLog({ appRoot: appDir, tool: 'posts.index', json: true })

      // By identity, not by count: two of the four seeded records are
      // `posts.index`, so a count of two also matches a filter that dropped the
      // wrong two, or one ignoring `--tool` under a stale `-n 2`.
      expect(printed().map((row) => JSON.parse(row)).map((record) => [record.tool, record.surface])).toEqual([
        ['posts.index', 'mcp'],
        ['posts.index', 'cli'],
      ])
    })

    it('filters by surface', async () => {
      await runToolLog({ appRoot: appDir, surface: 'webmcp', json: true })
      expect(printed().map((row) => JSON.parse(row).tool)).toEqual(['posts.destroy'])
    })

    it('filters to denials only', async () => {
      await runToolLog({ appRoot: appDir, denied: true, json: true })
      expect(printed().map((row) => JSON.parse(row).outcome)).toEqual(['denied', 'denied'])
    })

    it('refuses an unknown --surface instead of answering with an empty list', async () => {
      // An empty listing reads as "no agent calls happened" — the wrong
      // conclusion to hand someone who mistyped.
      await expect(runToolLog({ appRoot: appDir, surface: 'carrier-pigeon' })).rejects.toThrow('Unknown --surface')
    })

    it('applies -n after filtering, not before', async () => {
      // Filtering last would leave the denials outside the window and report
      // none, which over a busy trail is how a real denial goes unseen.
      const many = Array.from({ length: 10 }, (_unused, index) => line({ tool: `noise.${index}` }))
      await seed(TODAY, [
        ...many,
        line({ tool: 'posts.store', outcome: 'denied', reason: 'scope' }),
        line({ tool: 'posts.destroy', outcome: 'denied', reason: 'auth' }),
      ])

      await runToolLog({ appRoot: appDir, denied: true, limit: 5, json: true })

      expect(printed().map((row) => JSON.parse(row).tool)).toEqual(['posts.store', 'posts.destroy'])
    })
  })

  describe('the empty result', () => {
    it('names the configuration to add rather than printing an empty list', async () => {
      await runToolLog({ appRoot: appDir })

      expect(printed()).toHaveLength(0)
      const message = stderr()
      expect(message).toContain('No agent audit trail found')
      expect(message).toContain("mcpPlugin({ audit: { file: 'storage/logs/agent-audit.log' } })")
      // "Never wired" and "wired but nothing called yet" are indistinguishable
      // from here, so the message says both.
      expect(message).toContain('no tool has been called yet')
    })

    it('says the same when the directory exists but holds none of ours', async () => {
      await writeFile(join(logDir, 'app.log'), 'unrelated\n')

      await runToolLog({ appRoot: appDir })

      expect(stderr()).toContain('No agent audit trail found')
    })

    it('keeps --json pipeable by putting the explanation on stderr', async () => {
      await runToolLog({ appRoot: appDir, json: true })

      expect(printed()).toHaveLength(0)
      expect(stderr()).toContain('No agent audit trail found')
    })

    it('says a trail exists and holds nothing matching, which is a different answer', async () => {
      await seed(TODAY, [line({ tool: 'posts.index' })])

      await runToolLog({ appRoot: appDir, tool: 'posts.nothing' })

      expect(printed()).toHaveLength(0)
      expect(info()).toContain('holds no records matching those filters')
      // Not the other message: the two silences look identical but send a
      // reader to opposite places (plugin configuration vs. their filters).
      expect(stderr()).not.toContain('No agent audit trail found')
    })
  })

  describe('output', () => {
    it('prints one raw record per line under --json', async () => {
      await seed(TODAY, [line({ tool: 'posts.index' })])

      await runToolLog({ appRoot: appDir, json: true })

      const [row] = printed()
      expect(JSON.parse(row)).toEqual({
        ts: `${TODAY}T12:00:00.000Z`,
        outcome: 'invoked',
        surface: 'mcp',
        tool: 'posts.index',
        principal: { kind: 'user', id: 42 },
        arguments: { page: 1 },
        status: 200,
        durationMs: 7,
      })
      expect(row).not.toContain('agent.audit')
    })

    it('prints a human line carrying the outcome, tool, surface and principal', async () => {
      await seed(TODAY, [line({ tool: 'posts.store', outcome: 'denied', reason: 'rate-limit' })])

      await runToolLog({ appRoot: appDir })

      const [row] = printed()
      expect(row).toContain('denied')
      expect(row).toContain('rate-limit')
      expect(row).toContain('posts.store')
      expect(row).toContain('user:42')
    })

    it('paints nothing when stdout is not a terminal', async () => {
      // This listing is routinely piped without `--json`, and an escape code in
      // a stored audit line is noise a later reader cannot attribute.
      await seed(TODAY, [line({ tool: 'posts.store', outcome: 'denied', reason: 'rate-limit' })])
      const had = Object.hasOwn(process.stdout, 'isTTY')
      const original = process.stdout.isTTY

      try {
        // Both directions, so the negative assertion below is one that could
        // fail: with a terminal the same row *does* carry escape codes.
        process.stdout.isTTY = true
        await runToolLog({ appRoot: appDir })
        expect(printed()[0]).toContain('[')

        logSpy.mockClear()
        process.stdout.isTTY = false
        await runToolLog({ appRoot: appDir })
      } finally {
        if (had) process.stdout.isTTY = original
        else delete (process.stdout as { isTTY?: boolean }).isTTY
      }

      // Bun shares the process across test files, so an `isTTY` left behind as
      // `false` would quietly uncolour whatever ran next.
      expect(process.stdout.isTTY).toBe(original as boolean)

      const [row] = printed()
      expect(row).toContain('posts.store')
      expect(row).toContain('denied')
      expect(row).not.toContain('[')
    })
  })

  /**
   * Fake clock seeded on {@link TODAY}: the followed path is recomputed each
   * poll from the *wall* clock, and the fixtures are dated in 2087 for the
   * reason `agent/audit.test.ts` gives. An abandoned follow is harmless —
   * `readFrom` answers ENOENT with `null`.
   */
  describe('--tail', () => {
    interface Follow {
      controller: AbortController
      done: Promise<void>
      /** A follow that has returned has stopped. */
      settled: () => boolean
      failure: () => unknown
    }

    const follows: Follow[] = []

    beforeEach(() => {
      setSystemTime(new Date(`${TODAY}T12:00:00.000Z`))
    })

    afterEach(async () => {
      for (const running of follows.splice(0)) {
        running.controller.abort()
        await running.done
      }
      // Unconditionally: a mid-test throw must not hand the next file a
      // process living in 2087.
      setSystemTime()
    })

    function follow(options: Omit<ToolLogOptions, 'appRoot' | 'tail' | 'signal'> = {}): Follow {
      const controller = new AbortController()
      let settled = false
      let failure: unknown

      const done = runToolLog({ ...options, appRoot: appDir, tail: true, signal: controller.signal }).then(
        () => {
          settled = true
        },
        (error: unknown) => {
          settled = true
          failure = error
        },
      )

      const running: Follow = { controller, done, settled: () => settled, failure: () => failure }
      follows.push(running)
      return running
    }

    /** Real milliseconds — `setSystemTime` moves `Date`, not the timer queue. */
    function rest(ms: number): Promise<void> {
      return new Promise((done) => setTimeout(done, ms))
    }

    /** Long enough for at least `count` polls to have happened, and then some. */
    function poll(count = 1): Promise<void> {
      return rest(FOLLOW_INTERVAL_MS * count + 250)
    }

    async function waitFor(what: string, ready: () => boolean, timeoutMs = 6000): Promise<void> {
      const deadline = performance.now() + timeoutMs
      while (!ready()) {
        if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await rest(10)
      }
    }

    it('does not exit when there is no trail yet, and prints the first record to arrive', async () => {
      // Deliberately not `--json`: the explanation is suppressed under that flag
      // to keep stdout parseable, and it is the explanation on trial here.
      const running = follow()

      await poll()

      expect(running.settled()).toBe(false)
      expect(printed()).toHaveLength(0)
      expect(stderr()).toContain('No agent audit trail found')
      expect(stderr()).toContain('waiting here for the first record')

      await seed(TODAY, [line({ tool: 'first.call' })])
      await poll()

      expect(printed()).toHaveLength(1)
      expect(printed()[0]).toContain('first.call')
      expect(running.settled()).toBe(false)

      running.controller.abort()
      await running.done

      expect(running.settled()).toBe(true)
      expect(running.failure()).toBeUndefined()
    }, 20_000)

    it('prints a record appended while following exactly once', async () => {
      await seed(TODAY, [line({ tool: 'backlog.one' })])
      const running = follow({ json: true })

      // Waiting for the backlog row proves the initial read finished, so what
      // follows is strictly the follow's own doing.
      await waitFor('the backlog row', () => printed().length >= 1)
      expect(tools()).toEqual(['backlog.one'])

      await appendFile(logFile(TODAY), `${line({ tool: 'live.one' })}\n`)
      await poll()

      expect(tools()).toEqual(['backlog.one', 'live.one'])

      // Twice would mean a cursor reset on every poll.
      await poll()
      expect(tools()).toEqual(['backlog.one', 'live.one'])
      expect(running.settled()).toBe(false)
    }, 20_000)

    it('prints a record appended while the backlog is still being read', async () => {
      // The initial-offset race: a snapshot read plus a `stat` are two
      // observations of a growing file, and a record appended between them
      // belongs to neither. The window is widened deliberately to ~29ms with 300
      // dated files whose records all fail `--tool` (so nothing accumulates and
      // every file is still opened and parsed), against a 5ms append.
      const APPEND_DELAY_MS = 5
      const noise = Array.from({ length: 60 }, (_unused, index) => line({ tool: `noise.${index}` }))
      for (const stamp of stampsBefore(300)) await seed(stamp, noise)
      await seed(TODAY, [line({ tool: 'noise.today' })])

      // The window's width, measured on this machine rather than assumed, so a
      // machine fast enough to close it fails here instead of passing vacuously.
      const startedAt = performance.now()
      await runToolLog({ appRoot: appDir, tool: 'target', json: true })
      const backlogMs = performance.now() - startedAt

      expect(printed()).toHaveLength(0)
      expect(backlogMs).toBeGreaterThan(APPEND_DELAY_MS)

      const running = follow({ json: true, tool: 'target' })
      await rest(APPEND_DELAY_MS)
      await appendFile(logFile(TODAY), `${line({ tool: 'target' })}\n`)

      await waitFor('the appended record', () => running.settled() || printed().length >= 1)
      await poll()

      // Exactly once: not zero (a two-observation read loses it), not twice.
      expect(tools()).toEqual(['target'])
    }, 30_000)

    it('drains a complete record with no trailing newline when the file rolls over', async () => {
      // Holding a fragment is right on an ordinary poll, but after a rollover
      // nothing more is coming and the same restraint discards a whole record.
      setSystemTime(new Date(`${TODAY}T23:59:50.000Z`))
      await writeFile(logFile(TODAY), line({ tool: 'held.over' }))

      const running = follow({ json: true })
      await rest(200)

      // Held: the last line of a file being appended to is indistinguishable
      // from a partial write.
      expect(printed()).toHaveLength(0)

      setSystemTime(new Date(`${TOMORROW}T00:00:10.000Z`))
      await poll()

      expect(tools()).toEqual(['held.over'])
      expect(running.settled()).toBe(false)
    }, 20_000)

    it('does not prepend a stale fragment when the file is truncated before the rollover', async () => {
      // The bytes held between polls describe positions in the file as it was;
      // after a truncation, prepending them corrupts the first line of what
      // replaced them — at a rollover, that file's last chance to be read.
      setSystemTime(new Date(`${TODAY}T23:59:40.000Z`))
      await seed(TODAY, [line({ tool: 'before.truncate', args: { padding: 'x'.repeat(400) } })])

      const running = follow({ json: true })
      await waitFor('the backlog row', () => printed().length >= 1)

      // Held, not printed: no trailing newline.
      await appendFile(logFile(TODAY), line({ tool: 'never.completed', args: { padding: 'y'.repeat(400) } }))
      await poll(2)
      expect(tools()).toEqual(['before.truncate'])

      // Synchronous and with no `await` between the two: a poll landing between
      // the truncation and the clock change would make the assertion below hold
      // for the wrong reason.
      writeFileSync(logFile(TODAY), line({ tool: 'after.truncate' }))
      setSystemTime(new Date(`${TOMORROW}T00:00:10.000Z`))
      await poll()

      expect(tools()).toEqual(['before.truncate', 'after.truncate'])
      expect(running.settled()).toBe(false)
    }, 20_000)

    it('reassembles a multibyte character split across a poll boundary', async () => {
      // Decoding each read on its own turns the straddling character into
      // replacement bytes, dropping the record that carried it.
      await seed(TODAY, [line({ tool: 'ascii.first' })])
      const running = follow({ json: true })
      await waitFor('the backlog row', () => printed().length >= 1)

      const bytes = Buffer.from(`${line({ tool: 'greeting', args: { greeting: GREETING } })}\n`, 'utf8')
      // Inside the first character's three bytes, not between characters.
      const cut = bytes.indexOf(Buffer.from(GREETING, 'utf8')) + 1
      expect(cut).toBeGreaterThan(1)

      await appendFile(logFile(TODAY), bytes.subarray(0, cut))
      // Two polls, not one, so a poll must have observed the fragment and
      // chosen to hold it rather than simply not read yet.
      await poll(2)
      // Nothing yet: the line has no newline, so the whole fragment is held.
      expect(tools()).toEqual(['ascii.first'])

      await appendFile(logFile(TODAY), bytes.subarray(cut))
      await poll()

      expect(tools()).toEqual(['ascii.first', 'greeting'])
      const [, row] = printed()
      expect(JSON.parse(row).arguments).toEqual({ greeting: GREETING })
      expect(row).not.toContain('�')
      expect(running.settled()).toBe(false)
    }, 20_000)
  })
})

describe('tool:log flag handling (citty layer)', () => {
  let workspace: TempWorkspace
  let appDir: string
  let logSpy: Mock<typeof console.log>
  let warnSpy: Mock<typeof consola.warn>

  /**
   * Driven through `runCommand`, because the bug lives in citty's argument
   * layer: a repeated flag arrives as an *array*, and every array is truthy, so
   * `--denied=false --denied=false` reads as `true` unless the last value wins.
   */
  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-tool-log-flags-')
    appDir = join(workspace.dir, APP_DIR_NAME)
    await mkdir(join(appDir, 'storage', 'logs'), { recursive: true })
    await writeFile(
      join(appDir, 'storage', 'logs', `agent-audit-${TODAY}.log`),
      [
        line({ tool: 'posts.index' }),
        line({ tool: 'posts.store', outcome: 'denied', reason: 'scope' }),
      ].join('\n') + '\n',
    )

    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = spyOn(consola, 'warn').mockImplementation((() => {}) as never)
  })

  afterEach(async () => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    await workspace.cleanup()
  })

  async function run(rawArgs: string[]): Promise<void> {
    await runCommand(builtinSubCommands['tool:log'], { rawArgs: [...rawArgs, '--app', appDir, '--json'] })
  }

  function tools(): string[] {
    return logSpy.mock.calls.map((call) => JSON.parse(String(call[0])).tool)
  }

  it('reads a repeated --denied that ends in false as off', async () => {
    await run(['--denied=false', '--denied=false'])

    // Truthy-array handling would filter to denials and drop the invocation.
    expect(tools()).toEqual(['posts.index', 'posts.store'])
  })

  it('honours the last value of a repeated --denied that ends in true', async () => {
    await run(['--denied=false', '--denied=true'])

    expect(tools()).toEqual(['posts.store'])
  })

  it('reads the last --tool rather than joining repeats', async () => {
    // Joined, the repeat would match neither tool and list nothing.
    await run(['--tool', 'posts.index', '--tool', 'posts.store'])

    expect(tools()).toEqual(['posts.store'])
  })

  it('reads the last -n rather than joining repeats', async () => {
    await run(['-n', '2', '-n', '1'])

    expect(tools()).toEqual(['posts.store'])
  })

  it('refuses a non-numeric -n by name instead of listing nothing', async () => {
    await expect(run(['-n', 'lots'])).rejects.toThrow('-n must be a positive whole number')
  })

  it('reads a repeated --json that ends in false as off', async () => {
    await runCommand(builtinSubCommands['tool:log'], {
      rawArgs: ['--app', appDir, '--json', '--json=false'],
    })

    const rows = logSpy.mock.calls.map((call) => String(call[0]))
    // Asserted before the parse: `String(undefined)` is `'undefined'`, which
    // `JSON.parse` also throws on, so a throw alone proves nothing.
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('posts.index')
    expect(rows[1]).toContain('posts.store')
    expect(() => JSON.parse(rows[0])).toThrow()
  })
})

describe('parseSinceDuration', () => {
  it('reads each supported unit', () => {
    expect(parseSinceDuration('30s')).toBe(30_000)
    expect(parseSinceDuration('30m')).toBe(1_800_000)
    expect(parseSinceDuration('2h')).toBe(7_200_000)
    expect(parseSinceDuration('7d')).toBe(604_800_000)
  })

  it('refuses anything that is not a duration', () => {
    for (const raw of ['yesterday', '30', 'm', '-5m', '2w']) {
      expect(() => parseSinceDuration(raw)).toThrow('--since must be a duration')
    }
  })

  it('refuses a digit string too large to be a duration', () => {
    // The pattern accepts it and the multiplication overflows to Infinity,
    // whose cutoff is -Infinity: every record ever written, wearing the answer
    // to the question that was asked.
    const overflowing = `${'9'.repeat(309)}d`

    expect(Number(overflowing.slice(0, -1))).toBe(Number.POSITIVE_INFINITY)
    expect(() => parseSinceDuration(overflowing)).toThrow('too large to be a duration')
  })
})

describe('matchesFilters', () => {
  const record = parseAuditLines(line({ ts: `${TODAY}T12:00:00.000Z` }))[0]

  it('keeps a record newer than the cutoff and drops an older one', () => {
    const at = Date.parse(`${TODAY}T12:00:00.000Z`)

    expect(matchesFilters(record, { since: at - 1000 })).toBe(true)
    expect(matchesFilters(record, { since: at + 1000 })).toBe(false)
  })

  it('drops a record with an unreadable timestamp only when --since asks a question of it', () => {
    const broken = { ...record, ts: 'not a date' }

    expect(matchesFilters(broken, {})).toBe(true)
    expect(matchesFilters(broken, { since: 0 })).toBe(false)
  })
})
