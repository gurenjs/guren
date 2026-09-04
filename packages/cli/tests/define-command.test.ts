import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { defineCommand as defineCittyCommand, runCommand } from 'citty'
import { consola } from 'consola'
import { builtinSubCommands } from '../src/commands'
import { defineCommand, normalizeParsedArgs, normalizesRepeatedFlags } from '../src/define-command'

/**
 * Driven through citty's parser rather than around it: the defect lives in the
 * parse, so a test that hands a command pre-narrowed values passes whether or
 * not the command reads its flags safely.
 */
describe('defineCommand', () => {
  interface Seen {
    json: unknown
    dryRun: unknown
    name: unknown
    positional: string[]
  }

  function probe() {
    const seen: Seen[] = []
    const command = defineCommand({
      args: {
        json: { type: 'boolean' },
        // Declared camelCase and spelled `--dry-run`, which is the spelling
        // this CLI documents and the one citty never registers as a boolean.
        dryRun: { type: 'boolean', alias: 'd' },
        name: { type: 'string' },
      },
      run({ args }) {
        seen.push({ json: args.json, dryRun: args.dryRun, name: args.name, positional: args._ })
      },
    })
    return { seen, run: (rawArgs: string[]) => runCommand(command, { rawArgs }) }
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
    const { seen, run } = probe()
    await run(['--json=true', '--json=false'])
    await run(['--json=false', '--json=true'])
    await run(['--json', '--json=false'])
    await run(['--json', '--json'])
    expect(seen.map((s) => s.json)).toEqual([false, true, false, true])
    // The read every command actually performs.
    expect(seen.map((s) => Boolean(s.json))).toEqual([false, true, false, true])
  })

  it('holds for the kebab spelling of a camelCase boolean, which citty leaves a string', async () => {
    const { seen, run } = probe()
    await run(['--dry-run=true', '--dry-run=false'])
    await run(['--dry-run=false', '--dry-run=true'])
    // Single, not repeated: citty stores `"false"` under `dry-run` because it
    // registered only `dryRun` as a boolean, and that string is truthy.
    await run(['--dry-run=false'])
    await run(['--dry-run'])
    expect(seen.map((s) => s.dryRun)).toEqual([false, true, false, true])
    expect(seen.map((s) => Boolean(s.dryRun))).toEqual([false, true, false, true])
  })

  it('collapses an alias the same way, on the key citty stores it under', async () => {
    const { seen, run } = probe()
    await run(['-d=true', '-d=false'])
    await run(['-d', '-d'])
    expect(seen.map((s) => s.dryRun)).toEqual([false, true])
  })

  it('reads a repeated string as its last value and leaves positionals alone', async () => {
    const { seen, run } = probe()
    await run(['--name', 'a', '--name', 'b', 'first', 'second'])
    expect(seen).toEqual([{ json: undefined, dryRun: undefined, name: 'b', positional: ['first', 'second'] }])
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

  it('leaves `_` and declared strings alone while collapsing arrays', () => {
    const args: Record<string, unknown> = {
      _: ['a', 'b'],
      json: [true, false],
      name: ['x', 'false'],
      force: true,
    }
    normalizeParsedArgs(args, { json: { type: 'boolean' }, name: { type: 'string' } })
    // `name` collapses but keeps its string: only declared booleans are typed.
    expect(args).toEqual({ _: ['a', 'b'], json: false, name: 'false', force: true })
  })

  it('marks what it defines, and nothing else', () => {
    expect(normalizesRepeatedFlags(defineCommand({ run() {} }))).toBe(true)
    expect(normalizesRepeatedFlags(defineCittyCommand({ run() {} }))).toBe(false)
  })
})

describe('built-in commands', () => {
  it('all define themselves through the wrapper', () => {
    // A command importing `defineCommand` from `citty` instead reads raw
    // arrays again, with nothing else to say so — the reading sites look
    // identical either way.
    const bypassing = Object.entries(builtinSubCommands)
      .filter(([, command]) => !normalizesRepeatedFlags(command))
      .map(([name]) => name)
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
