import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { defineCommand as defineCittyCommand, runCommand } from 'citty'
import type { CommandDef } from 'citty'
import { consola } from 'consola'
import { builtinSubCommands } from '../src/commands'
import { defineCommand, normalizesRepeatedFlags } from '../src/define-command'
import { resolveValue } from '../src/run-cli'

/**
 * Driven through citty's parser rather than around it: the defect lives in the
 * parse, so a test that hands a command pre-narrowed values passes whether or
 * not the command reads its flags safely.
 */
describe('defineCommand', () => {
  /** One run of a probe command, read the way a command's own body reads it. */
  async function parse(rawArgs: string[]): Promise<Record<string, unknown>> {
    let seen!: Record<string, unknown>
    const command = defineCommand({
      args: {
        json: { type: 'boolean' },
        // Declared camelCase on purpose: no command declares `dryRun` any more,
        // and this pins the citty behaviour the coercion still backstops.
        dryRun: { type: 'boolean', alias: 'd' },
        name: { type: 'string' },
      },
      run({ args }) {
        seen = args as Record<string, unknown>
      },
    })
    await runCommand(command, { rawArgs })
    return seen
  }

  it('is needed: citty itself arrays a repeated flag, and every array is truthy', async () => {
    // The premise, pinned. If citty ever collapses repeats on its own this
    // fails first, and the wrapper below is the thing to delete.
    let raw: unknown
    const command = defineCittyCommand({
      args: { json: { type: 'boolean' } },
      run({ args }) {
        raw = args.json
      },
    })
    await runCommand(command, { rawArgs: ['--json=true', '--json=false'] })
    expect(raw).toEqual([true, false])
    expect(Boolean(raw)).toBe(true)
  })

  it('reads a repeated boolean as its last value in both directions', async () => {
    expect((await parse(['--json=true', '--json=false'])).json).toBe(false)
    expect((await parse(['--json=false', '--json=true'])).json).toBe(true)
    expect((await parse(['--json', '--json=false'])).json).toBe(false)
    expect((await parse(['--json', '--json'])).json).toBe(true)
  })

  it('holds for the kebab spelling of a camelCase boolean, which citty leaves a string', async () => {
    expect((await parse(['--dry-run=true', '--dry-run=false'])).dryRun).toBe(false)
    expect((await parse(['--dry-run=false', '--dry-run=true'])).dryRun).toBe(true)
    // Single, not repeated: citty stores `"false"` under `dry-run` because it
    // registered only `dryRun` as a boolean, and that string is truthy.
    expect((await parse(['--dry-run=false'])).dryRun).toBe(false)
    // The alias citty stores under its own key and copies to the declared one.
    expect((await parse(['-d=true', '-d=false'])).dryRun).toBe(false)
    expect((await parse(['-d', '-d'])).dryRun).toBe(true)
  })

  it('collapses a repeated string, keeps its text, and leaves positionals alone', async () => {
    expect(await parse(['--name', 'a', '--name', 'b', 'first', 'second'])).toEqual({
      _: ['first', 'second'],
      name: 'b',
    })
    // Only declared booleans are typed: a string arg keeps the word.
    expect((await parse(['--name=false', '--name=false'])).name).toBe('false')
  })

  it('normalizes before setup as well as before run', async () => {
    const order: unknown[] = []
    const command = defineCommand({
      args: { json: { type: 'boolean' } },
      setup({ args }) {
        order.push(['setup', args.json])
      },
      run({ args }) {
        order.push(['run', args.json])
      },
    })
    await runCommand(command, { rawArgs: ['--json=true', '--json=false'] })
    expect(order).toEqual([
      ['setup', false],
      ['run', false],
    ])
  })

  it('marks what it defines, and nothing else', () => {
    expect(normalizesRepeatedFlags(defineCommand({ run() {} }))).toBe(true)
    expect(normalizesRepeatedFlags(defineCittyCommand({ run() {} }))).toBe(false)
  })
})

describe('built-in commands', () => {
  /** Every registered command, including those nested under `guren add`. */
  async function everyCommand(
    commands: Record<string, CommandDef<never>>,
    prefix = '',
  ): Promise<Array<[string, CommandDef<never>]>> {
    const found: Array<[string, CommandDef<never>]> = []
    for (const [name, command] of Object.entries(commands)) {
      const path = prefix ? `${prefix} ${name}` : name
      found.push([path, command])
      const nested = await resolveValue(command.subCommands)
      if (nested) found.push(...(await everyCommand(nested as Record<string, CommandDef<never>>, path)))
    }
    return found
  }

  it('declare every arg with the spelling citty registers', async () => {
    // A camelCase declaration makes `renderUsage` advertise `--dryRun` while the
    // docs say `--dry-run`. For a boolean the documented spelling then arrives as
    // the truthy string `"false"` instead of parsing; for a string citty's proxy
    // resolves either way and only the usage line is wrong. Aliases are exempt:
    // `renderUsage` renders them single-dashed, so a kebab alias prints worse.
    const camelCased: string[] = []
    for (const [path, command] of await everyCommand(builtinSubCommands as Record<string, CommandDef<never>>)) {
      for (const name of Object.keys((await resolveValue(command.args)) ?? {})) {
        if (/[A-Z]/u.test(name)) camelCased.push(`${path} --${name}`)
      }
    }
    expect(camelCased).toEqual([])
  })

  it('all define themselves through the wrapper, nested ones included', async () => {
    // A command importing `defineCommand` from `citty` instead reads raw arrays
    // again, with nothing else to say so — the reading sites look identical
    // either way. `guren add <blueprint>` is the reason this recurses: those 14
    // declare their own `--force`, one level below the registry.
    const bypassing = (await everyCommand(builtinSubCommands as Record<string, CommandDef<never>>))
      .filter(([, command]) => !normalizesRepeatedFlags(command))
      .map(([path]) => path)
    expect(bypassing).toEqual([])
  })
})

/**
 * A command that read `Boolean(args.json)` raw before the wrapper existed,
 * driven end to end. `--dry-run` keeps it away from any database: the only
 * thing the repeated flag decides here is which reporter runs.
 */
describe('db:migrate flag parsing', () => {
  let logs: string[]
  let infos: string[]
  let logSpy: ReturnType<typeof spyOn>
  let infoSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    logs = []
    infos = []
    logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    // consola types a log method with a `raw` variant; the sentinel is all
    // the assertions need.
    infoSpy = spyOn(consola, 'info').mockImplementation(((...args: unknown[]) => {
      infos.push(args.map(String).join(' '))
    }) as never)
  })

  afterEach(() => {
    infoSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('reports as text when a repeated --json ends in false', async () => {
    await runCommand(builtinSubCommands['db:migrate'], { rawArgs: ['--dry-run', '--json=true', '--json=false'] })
    expect(logs).toEqual([])
    expect(infos).toEqual(['[dry-run] Would run all pending database migrations.'])
  })

  it('reports as JSON when a repeated --json ends in true', async () => {
    await runCommand(builtinSubCommands['db:migrate'], { rawArgs: ['--dry-run', '--json=false', '--json=true'] })
    expect(infos).toEqual([])
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0]!)).toMatchObject({ dryRun: true, action: 'db:migrate' })
  })
})
