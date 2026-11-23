import { describe, expect, test } from 'bun:test'

import { parseArgs, type ArgsDef } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { jobFile } from '../src/make-job'
import { channelFile } from '../src/make-channel'
import { listenerFile } from '../src/make-listener'
import { providerFile } from '../src/make-provider'
import { judgePlanCommand, planGeneratorNames } from '../src/plan/command-allowlist'
import { PLAN_COMMAND_FILES, PLAN_COMMAND_FLAG_ALIASES, planCommandClaims, planCommandFiles } from '../src/plan/command-files'
import { PlanSchema, type PlanDraft } from '../src/plan/schema'
import { resolveValue } from '../src/run-cli'
import { loadApprovedCommentsPlan } from './plan-fixture'

type ArgDefinition = { type?: string; alias?: string | string[] }

/** The registry's flags for a generator, by type, aliases included. */
async function registryFlags(name: string): Promise<{ string: string[]; boolean: string[] }> {
  const command = (await resolveValue(builtinSubCommands[name as keyof typeof builtinSubCommands])) as { args?: unknown }
  const args = Object.entries(((await resolveValue(command.args as never)) ?? {}) as Record<string, ArgDefinition>)
  const of = (type: string): string[] => args.filter(([, definition]) => definition.type === type).flatMap(([key, definition]) => [key, ...[definition.alias ?? []].flat()]).sort()
  return { string: of('string'), boolean: of('boolean') }
}

function planWith(commands: string[], edit?: (document: Record<string, any>) => void): PlanDraft {
  const document = loadApprovedCommentsPlan() as Record<string, any>
  document.commands = commands.map((command, index) => ({ id: `command.${index}`, command, reason: 'needed' }))
  edit?.(document)
  return PlanSchema.parse(document)
}

describe('PLAN_COMMAND_FILES', () => {
  test('should name only generators a plan may run', () => {
    const allowed = new Set(planGeneratorNames())
    expect(Object.keys(PLAN_COMMAND_FILES).filter((name) => !allowed.has(name))).toEqual([])
  })

  test('should read each generator with the value flags the registry declares, and a subset of its boolean flags', async () => {
    const mismatches: string[] = []
    for (const [name, rule] of Object.entries(PLAN_COMMAND_FILES)) {
      const registry = await registryFlags(name)
      if (JSON.stringify([...rule.valueFlags].sort()) !== JSON.stringify(registry.string)) mismatches.push(`${name}: value flags ${[...rule.valueFlags].sort().join(',')}, registry ${registry.string.join(',')}`)
      for (const flag of rule.booleanFlags) if (!registry.boolean.includes(flag)) mismatches.push(`${name}: --${flag} is no boolean flag of the registry`)
    }
    expect(mismatches).toEqual([])
  })

  test("should name each alias the registry gives a flag the table reads, with its long name", async () => {
    const expected: Record<string, string> = {}
    for (const name of Object.keys(PLAN_COMMAND_FILES)) {
      const command = (await resolveValue(builtinSubCommands[name as keyof typeof builtinSubCommands])) as { args?: unknown }
      for (const [key, definition] of Object.entries(((await resolveValue(command.args as never)) ?? {}) as Record<string, ArgDefinition>)) {
        for (const alias of [definition.alias ?? []].flat()) expected[alias] = key
      }
    }
    expect(PLAN_COMMAND_FLAG_ALIASES).toEqual(expected)
  })
})

describe('planCommandFiles', () => {
  test('should give the path and contents the generator writes, in command order', () => {
    const files = planCommandFiles(planWith(['bunx guren make:job SendDigest', 'guren make:provider Queue --module billing']))

    expect(files).toEqual([
      { commandId: 'command.0', elements: [], path: jobFile('SendDigest').path, contents: [jobFile('SendDigest').contents], check: { kind: 'whole' } },
      { commandId: 'command.1', elements: [], path: providerFile('Queue', { root: 'billing' }).path, contents: [providerFile('Queue', { root: 'billing' }).contents], check: { kind: 'whole' } },
    ])
    expect(files[1]!.path).toBe('modules/billing/app/Providers/QueueProvider.ts')
  })

  test('should give both controllers make:controller may write, since the plan does not say whether the app renders pages', () => {
    const [file] = planCommandFiles(planWith(['guren make:controller Report']))

    expect(file!.path).toBe('app/Http/Controllers/ReportController.ts')
    expect(file!.contents).toHaveLength(2)
    expect(file!.contents[0]).toContain('this.inertia(')
    expect(file!.contents[1]).toContain('this.json(')
  })

  test('should read value flags and boolean flags as the command does', () => {
    const [listener, channel] = planCommandFiles(planWith(['guren make:listener NotifyAuthor --event CommentPosted', 'guren make:channel Orders --private']))

    expect(listener!.contents[0]).toContain('CommentPosted')
    expect(channel!.contents[0]).not.toEqual(planCommandFiles(planWith(['guren make:channel Orders']))[0]!.contents[0])
  })

  test.each([
    ['a flag the generator does not take', 'guren make:job SendDigest --queue high'],
    ['a boolean flag given a value', 'guren make:channel Orders --private=false'],
    ['a value flag with no value', 'guren make:listener NotifyAuthor --event'],
    ['no name', 'guren make:job'],
    ['fields the generator refuses', 'guren make:validator Comment --fields "body:nonsense"'],
    ['a generator writing more than one file', 'guren make:feature Post'],
    ['a blueprint', 'guren add queue'],
    ['a command the allowlist refuses', 'guren make:job Send;Digest'],
    ['a boolean followed by a value the registry would take as its value', 'guren make:model Invoice --force true'],
    ['a single dash before several letters, which the registry reads as short flags', 'guren make:model Invoice -module billing'],
    ['one flag under both spellings, of which the registry keeps the first', 'guren make:job SendDigest -M billing --module sales'],
    ['a quote, which would reach a generated string literal unescaped', `guren make:channel Orders --channel "x' + process.env.APP_KEY + 'y"`],
    ['an empty `=` value, after which the registry takes the next word', 'guren make:job SendDigest --module= billing'],
    ['a value flag followed by a flag, which the registry leaves empty', 'guren make:listener NotifyAuthor --event --force'],
    ['a cluster of short flags', 'guren make:job SendDigest -fM billing'],
    ['`--`, after which every word is a name', 'guren make:model Invoice -- --force'],
    ['an empty word after a boolean, which the registry takes as its value', 'guren make:channel Orders --private ""'],
    ['a blank word, which the registry reads as a number', 'guren make:job --force " " Invoice'],
    ['a flag before the name', 'guren make:job --force SendDigest'],
    ['an empty value, which make:validator reads as no fields', 'guren make:validator Tag --fields ""'],
  ])('should declare nothing for %s', (_why, command) => {
    expect(planCommandFiles(planWith([command]))).toEqual([])
  })

  test('should claim what a command may write even where its call does not read, in the root and each module it names', () => {
    const claims = planCommandClaims(planWith(['guren make:job SendDigest --verbose -M billing', 'guren make:job Other --module= sales', 'guren make:model -- --force']))

    expect([...(claims.get('command.0') as Set<string>)]).toEqual(expect.arrayContaining(['app/Jobs/SendDigestJob.ts', 'modules/billing/app/Jobs/SendDigestJob.ts']))
    expect([...(claims.get('command.1') as Set<string>)]).toContain('modules/sales/app/Jobs/OtherJob.ts')
    expect([...(claims.get('command.2') as Set<string>)]).toContain('app/Models/Force.ts')
  })

  test('should claim every path for a generator writing more than its file, and for a command the allowlist refuses', () => {
    const claims = planCommandClaims(planWith(['guren make:feature Post', 'guren add cache', 'bun run seed', 'guren make:adr "A decision"']))

    expect([...claims]).toEqual([['command.0', 'all'], ['command.1', 'all'], ['command.2', 'all']])
  })

  test('should declare only what the registry would parse the same way, over every short call', async () => {
    const definitions = async (name: string): Promise<ArgsDef> => {
      const command = (await resolveValue(builtinSubCommands[name as keyof typeof builtinSubCommands])) as { args?: unknown }
      return ((await resolveValue(command.args as never)) ?? {}) as ArgsDef
    }
    const words = ['Orders', 'billing', 'true', '""', '" "', '--force', '-f', '--module', '-M', '--module=', '--module=billing', '--', '-fM', '--event', '-e', '--event=Posted', '--private', '-p', '--channel', 'orders']
    const mismatches: string[] = []
    for (const name of ['make:job', 'make:listener', 'make:channel']) {
      const args = await definitions(name)
      const calls: string[][] = []
      const grow = (call: string[]): void => {
        if (call.includes('Orders')) calls.push(call)
        if (call.length < 3) for (const word of words) grow([...call, word])
      }
      grow([])
      for (const call of calls) {
        const command = `guren ${name} ${call.join(' ')}`
        const verdict = judgePlanCommand(command)
        if (!verdict.allowed) continue
        const [read] = planCommandFiles(planWith([command]))
        if (!read) continue
        const parsed = parseArgs(verdict.args, args) as Record<string, unknown>
        // As `defineCommand()` normalizes it, and as `commands/make.ts` hands it to the generator.
        const last = (key: string): unknown => (Array.isArray(parsed[key]) ? (parsed[key] as unknown[]).at(-1) : parsed[key])
        const text = (key: string): string | undefined => (typeof last(key) === 'string' && last(key) !== '' ? (last(key) as string) : undefined)
        const on = (key: string): boolean => last(key) === true || last(key) === 'true'
        if (typeof parsed.name !== 'string') {
          mismatches.push(`${command}: writes nothing, declared ${read.path}`)
          continue
        }
        const options = { root: text('module') }
        const real = name === 'make:job' ? jobFile(parsed.name, options)
          : name === 'make:listener' ? listenerFile(parsed.name, { ...options, event: text('event') })
          : channelFile(parsed.name, { ...options, channel: text('channel'), private: on('private'), presence: on('presence') })
        if (real.path !== read.path || !read.contents.includes(real.contents)) mismatches.push(`${command}: writes ${real.path}, declared ${read.path}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  test('should hold a file by the check of the added element that owns its class, in the same module', () => {
    const effect = (module?: string) => (document: Record<string, any>) => {
      document.sideEffects = [{ id: 'job.digest', change: { kind: 'add' }, kind: 'job', name: 'SendDigestJob', ...(module ? { module } : {}), trigger: 'nightly', description: 'd' }]
    }

    expect(planCommandFiles(planWith(['guren make:job SendDigest --module Billing'], effect('billing')))).toMatchObject([{ elements: ['job.digest'], check: { kind: 'exports' } }])
    expect(planCommandFiles(planWith(['guren make:job SendDigest'], effect('billing')))).toMatchObject([{ elements: [], check: { kind: 'whole' } }])
  })

  test("should hold a policy by the planned abilities, and a policy's provider whole whatever the plan names", () => {
    const [policy] = planCommandFiles(planWith(['guren make:policy Comment --module billing'], (document) => {
      document.policies[0].module = 'billing'
    }))
    const [provider] = planCommandFiles(planWith(['guren make:provider CommentPolicy']))

    expect(policy).toMatchObject({ elements: ['policy.comment'], check: { kind: 'policy' } })
    expect(provider).toMatchObject({ elements: [], check: { kind: 'whole' } })
  })
})
