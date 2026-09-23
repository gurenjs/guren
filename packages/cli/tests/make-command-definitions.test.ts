import { describe, expect, it } from 'bun:test'
import { join, resolve } from 'node:path'
import { runCommand } from 'citty'
import { builtinSubCommands } from '../src/commands'
import * as makeModule from '../src/commands/make'
import { describePath } from '../src/commands/display-paths'
import { UsageError } from '../src/run-cli'

describe('make command definitions', () => {
  it('registers every command make.ts exports', () => {
    const registered = new Set<unknown>(Object.values(builtinSubCommands))
    const { makeCommands, ...standalone } = makeModule
    const exported = [
      ...Object.values(makeCommands),
      ...Object.entries(standalone).filter(([name]) => name.endsWith('Command')).map(([, command]) => command),
    ]

    expect(exported.length).toBeGreaterThan(0)
    for (const command of exported) {
      expect(registered.has(command)).toBe(true)
    }
  })

  it('rejects a non-numeric make:exception --status', async () => {
    const promise = runCommand(builtinSubCommands['make:exception'], { rawArgs: ['Teapot', '--status', 'abc'] })
    await expect(promise).rejects.toBeInstanceOf(UsageError)
  })

  it('rejects a make:exception --status outside the HTTP error range', async () => {
    const promise = runCommand(builtinSubCommands['make:exception'], { rawArgs: ['Teapot', '--status', '200'] })
    await expect(promise).rejects.toBeInstanceOf(UsageError)
  })

  it('rejects an unknown make:test --runner with a UsageError', async () => {
    const promise = runCommand(builtinSubCommands['make:test'], { rawArgs: ['Widget', '--runner', 'jest'] })
    await expect(promise).rejects.toBeInstanceOf(UsageError)
  })
})

describe('describePath', () => {
  it('keeps a cwd directory whose name starts with ".." relative', () => {
    expect(describePath(join(process.cwd(), '..generated/schema.ts'))).toBe(join('..generated', 'schema.ts'))
  })

  it('prints a path outside cwd verbatim', () => {
    const outside = resolve(process.cwd(), '../elsewhere/schema.ts')
    expect(describePath(outside)).toBe(outside)
  })
})
