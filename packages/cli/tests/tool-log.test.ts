import { describe, it, expect, beforeEach, afterEach, setSystemTime, spyOn, type Mock } from 'bun:test'
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
 * The audit reader end to end: which files it reads, in what order, what it
 * filters, and what it says when there is nothing.
 *
 * The trail lives in a *subdirectory* of the workspace, because
 * `createTempWorkspace` chdirs into the workspace it makes. An app fixture at
 * its root would leave `--app` and the process cwd pointing at the same place,
 * and every case here would pass whether or not the command honoured the flag.
 */
const APP_DIR_NAME = 'app'

/** Future-seeded, like the server-side fixtures: a past epoch expires everything. */
const TODAY = '2087-03-14'
const YESTERDAY = '2087-03-13'
const TOMORROW = '2087-03-15'

/**
 * How often `--tail` polls, mirroring the command's own `FOLLOW_INTERVAL_MS`.
 *
 * Copied rather than imported: it is not part of what this command promises a
 * caller, and exporting it to satisfy a test would make it so. The follow tests
 * wait comfortably past it, so a change to the real interval slows them down
 * rather than making them wrong — until it exceeds this, which the waits would
 * then time out on by name.
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
  // The envelope `DailyFileChannel`'s JSON format adds. Written here rather
  // than assumed away, so this test fails if the reader ever stops tolerating
  // it — which is the only thing keeping the sink able to reuse the channel.
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

      // Chronological on the page, whatever order the files were opened in.
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

      // The rows by identity, not by count. Two of the four seeded records are
      // `posts.index`, so a count of two is also what a filter that dropped
      // the wrong two would print — and what an implementation ignoring
      // `--tool` and honouring a stale `-n 2` would print as well.
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
      // An empty listing on this command reads as "no agent calls happened",
      // which is exactly the wrong conclusion to hand someone who mistyped.
      await expect(runToolLog({ appRoot: appDir, surface: 'carrier-pigeon' })).rejects.toThrow('Unknown --surface')
    })

    it('applies -n after filtering, not before', async () => {
      // Ten invocations then two denials: filtering last would leave the
      // denials outside the window and report none, which over a busy trail is
      // how a real denial goes unseen.
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
      // Honest about both readings: from here, "never wired" and "wired but
      // nothing called yet" are indistinguishable.
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
      // And emphatically *not* the other message. The two silences look
      // identical on the page and send a reader to opposite places: one to the
      // plugin configuration, one to the filters they just typed.
      expect(stderr()).not.toContain('No agent audit trail found')
    })
  })

  describe('output', () => {
    it('prints one raw record per line under --json', async () => {
      await seed(TODAY, [line({ tool: 'posts.index' })])

      await runToolLog({ appRoot: appDir, json: true })

      const [row] = printed()
      // The record, not the envelope the channel wrapped it in.
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
      // This listing is routinely piped without `--json` — into `grep`, into a
      // file kept with an incident — and an escape code embedded in a stored
      // audit line is noise a later reader has no way to attribute.
      await seed(TODAY, [line({ tool: 'posts.store', outcome: 'denied', reason: 'rate-limit' })])
      const had = Object.hasOwn(process.stdout, 'isTTY')
      const original = process.stdout.isTTY

      try {
        // Both directions, so the negative assertion below is one that could
        // fail: with a terminal the same row *does* carry escape codes, which
        // is what proves the check is reading something real.
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

      // The restore actually took. This is the one piece of global state these
      // tests write, and Bun shares the process across every test file — an
      // `isTTY` left behind as `false` would quietly uncolour whatever ran next.
      expect(process.stdout.isTTY).toBe(original as boolean)

      const [row] = printed()
      expect(row).toContain('posts.store')
      expect(row).toContain('denied')
      expect(row).not.toContain('[')
    })
  })

  /**
   * The follow loop.
   *
   * Every case here runs against a fake clock seeded on {@link TODAY}, because
   * the followed path is recomputed each poll from `dailyFilePath(basePath, new
   * Date())` — a follow reads the file the *wall* clock names, and the fixtures
   * are dated in 2087 for the reason `agent/audit.test.ts` gives.
   *
   * Follows are registered as they are started and aborted in `afterEach`
   * before the workspace is removed. A `--tail` that outlives its test does not
   * crash: `readFrom` answers ENOENT with `null`, so an abandoned loop polls a
   * deleted directory quietly for the rest of the run.
   */
  describe('--tail', () => {
    interface Follow {
      controller: AbortController
      done: Promise<void>
      /** Whether `runToolLog` has returned. A follow that returns has stopped. */
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
      // Unconditionally, and before the outer hook removes the workspace: a
      // mid-test throw must not hand the next file a process living in 2087.
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
      // The regression: `--tail` used to return immediately when the trail did
      // not exist, so an operator who had just wired the sink and was waiting
      // for the first agent call got the "no trail" notice and their prompt
      // back — which reads as "and there never will be".
      // Deliberately not `--json`: the explanation below is suppressed under
      // that flag so a caller piping stdout into a parser still gets a clean
      // stream, and it is the explanation that is on trial here.
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

      // Waiting for the backlog row *is* the proof that the initial read
      // finished: the follow resumes from the position that read reached, so
      // everything after this point is strictly the follow's own doing.
      await waitFor('the backlog row', () => printed().length >= 1)
      expect(tools()).toEqual(['backlog.one'])

      await appendFile(logFile(TODAY), `${line({ tool: 'live.one' })}\n`)
      await poll()

      expect(tools()).toEqual(['backlog.one', 'live.one'])

      // Twice would mean the follow re-read from an offset it had already
      // passed — which is what a cursor reset on every poll looks like.
      await poll()
      expect(tools()).toEqual(['backlog.one', 'live.one'])
      expect(running.settled()).toBe(false)
    }, 20_000)

    it('prints a record appended while the backlog is still being read', async () => {
      // The initial-offset race. A snapshot read followed by a `stat` is two
      // observations of a growing file, and a record appended between them
      // belongs to neither — the snapshot was taken before it arrived, the
      // follow resumes past it. Reading once and keeping *that* read's position
      // leaves it nowhere to fall.
      //
      // The window is a fraction of a millisecond wide on an empty trail, so
      // it is widened deliberately: a rotation set of 300 dated files whose
      // records all fail the `--tool` filter. Failing the filter is the point —
      // nothing accumulates, so `collectRecords` never reaches its limit and
      // never breaks early, and every one of those files is opened and parsed
      // while the append below is landing. Measured at ~29ms against a 5ms
      // append, and the measurement is repeated below rather than trusted.
      const APPEND_DELAY_MS = 5
      const noise = Array.from({ length: 60 }, (_unused, index) => line({ tool: `noise.${index}` }))
      for (const stamp of stampsBefore(300)) await seed(stamp, noise)
      await seed(TODAY, [line({ tool: 'noise.today' })])

      // The window's width, measured on this machine rather than assumed: an
      // ordinary run over the same corpus does the same scan the follow does
      // before its first poll. Asserted, so a machine fast enough to close the
      // window before the append lands fails here — naming the construction —
      // instead of passing vacuously further down.
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

      // Exactly once: not zero (the old two-observation read would lose it),
      // and not twice.
      expect(tools()).toEqual(['target'])
    }, 30_000)

    it('drains a complete record with no trailing newline when the file rolls over', async () => {
      // A held fragment is right on every ordinary poll — its remainder is
      // still on the way. After a rollover nothing further is coming to that
      // file, and the same restraint would discard a record that is already
      // complete.
      setSystemTime(new Date(`${TODAY}T23:59:50.000Z`))
      await writeFile(logFile(TODAY), line({ tool: 'held.over' }))

      const running = follow({ json: true })
      await rest(200)

      // Held, not printed: from the follow's point of view the last line of a
      // file being appended to is indistinguishable from a partial write.
      expect(printed()).toHaveLength(0)

      setSystemTime(new Date(`${TOMORROW}T00:00:10.000Z`))
      await poll()

      expect(tools()).toEqual(['held.over'])
      expect(running.settled()).toBe(false)
    }, 20_000)

    it('reassembles a multibyte character split across a poll boundary', async () => {
      // What the `StringDecoder` held across polls is for. Decoding each read
      // on its own turns the straddling character into replacement bytes, and
      // the record carrying it is lost — which is to say an audit trail would
      // drop a call because one of its arguments was not written in ASCII.
      await seed(TODAY, [line({ tool: 'ascii.first' })])
      const running = follow({ json: true })
      await waitFor('the backlog row', () => printed().length >= 1)

      const bytes = Buffer.from(`${line({ tool: 'greeting', args: { greeting: GREETING } })}\n`, 'utf8')
      // Inside the first character's three bytes, not between characters.
      const cut = bytes.indexOf(Buffer.from(GREETING, 'utf8')) + 1
      expect(cut).toBeGreaterThan(1)

      await appendFile(logFile(TODAY), bytes.subarray(0, cut))
      // Two polls, not one, so this assertion cannot pass because nothing has
      // been read yet: a window of that length guarantees a poll observed the
      // fragment and chose to hold it, which is the claim being made.
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
   * Driven through `runCommand`, not through `runToolLog`.
   *
   * The bug these cover lives in the argument layer citty owns: a repeated
   * flag arrives as an *array*, and every array is truthy, so
   * `--denied=false --denied=false` reads as `true` unless the wiring takes
   * the last value. A test calling `runToolLog` directly passes a plain
   * boolean and never touches the layer where that happens — which is how the
   * gap reached review on the neighbouring command.
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
    // Joined, the repeat would read as one name matching neither tool and the
    // listing would be empty.
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
    // `--json` is appended by `run()`, so a `--json=false` after it must win —
    // the human line is not JSON, and parsing it would throw.
    await runCommand(builtinSubCommands['tool:log'], {
      rawArgs: ['--app', appDir, '--json', '--json=false'],
    })

    const rows = logSpy.mock.calls.map((call) => String(call[0]))
    // Asserted *before* the parse, and this is the whole point of the two
    // lines: `String(undefined)` is `'undefined'`, which `JSON.parse` also
    // throws on — so a check that only asserted the throw passed just as well
    // when the command had printed nothing at all.
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
    // Defaulting would either widen the window silently or empty it silently;
    // both look like an answer.
    for (const raw of ['yesterday', '30', 'm', '-5m', '2w']) {
      expect(() => parseSinceDuration(raw)).toThrow('--since must be a duration')
    }
  })

  it('refuses a digit string too large to be a duration', () => {
    // The shape is right — digits then a unit — so the pattern accepts it and
    // the multiplication overflows to Infinity. Its cutoff is -Infinity, which
    // keeps every record ever written: no filter at all, wearing the answer to
    // the question that was asked. Refused like any other unusable duration.
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
