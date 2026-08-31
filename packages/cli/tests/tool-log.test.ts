import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runCommand } from 'citty'
import { consola } from 'consola'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { builtinSubCommands } from '../src/commands'
import { runToolLog, matchesFilters, parseSinceDuration, parseAuditLines } from '../src/tool-log'

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

interface RecordOverrides {
  ts?: string
  tool?: string
  surface?: string
  outcome?: 'invoked' | 'denied'
  reason?: string
  status?: number
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
    arguments: { page: 1 },
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

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-tool-log-')
    appDir = join(workspace.dir, APP_DIR_NAME)
    logDir = join(appDir, 'storage', 'logs')
    await mkdir(logDir, { recursive: true })

    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    errSpy = spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = spyOn(consola, 'warn').mockImplementation((() => {}) as never)
  })

  afterEach(async () => {
    logSpy.mockRestore()
    errSpy.mockRestore()
    warnSpy.mockRestore()
    await workspace.cleanup()
  })

  async function seed(stamp: string, lines: string[]): Promise<void> {
    await writeFile(join(logDir, `agent-audit-${stamp}.log`), `${lines.join('\n')}\n`)
  }

  function printed(): string[] {
    return logSpy.mock.calls.map((call) => String(call[0]))
  }

  function stderr(): string {
    return [...warnSpy.mock.calls, ...errSpy.mock.calls].flat().map(String).join('\n')
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
      expect(printed()).toHaveLength(2)
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

    expect(() => JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toThrow()
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
