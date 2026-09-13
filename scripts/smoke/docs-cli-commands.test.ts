import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  auditDocsCliCommands,
  formatUnknownCliCommand,
  frameworkConsoleCommands,
  registeredCliCommands,
  type UnknownCliCommand,
} from './docs-cli-commands'

const repoRoot = join(import.meta.dir, '..', '..')

let scratch: string

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'guren-docs-cli-'))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

let fixtureCount = 0
async function auditMarkdown(markdown: string): Promise<UnknownCliCommand[]> {
  const dir = join(scratch, `case-${(fixtureCount += 1)}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'page.md'), markdown)
  return auditDocsCliCommands(repoRoot, dir)
}

describe('the registry the gate reads', () => {
  test('holds builtins and first-party plugin commands, not app console commands', async () => {
    const registered = await registeredCliCommands(repoRoot)

    expect(registered.has('db:status')).toBe(true)
    expect(registered.has('cloudflare:build')).toBe(true)
    expect(registered.has('attachments:prune')).toBe(false)
  })

  test('finds the console commands the framework ships', async () => {
    expect((await frameworkConsoleCommands(repoRoot)).has('attachments:prune')).toBe(true)
  })
})

describe('auditDocsCliCommands', () => {
  test('reports an app console command spelled as a CLI command, in a fence and inline', async () => {
    const unknown = await auditMarkdown(
      ['```bash', 'bunx guren attachments:prune --dry-run', '```', '', 'Then `bunx guren attachments:prune` finds them.'].join('\n'),
    )

    expect(unknown.map(({ line, command, consoleCommand }) => ({ line, command, consoleCommand }))).toEqual([
      { line: 2, command: 'attachments:prune', consoleCommand: true },
      { line: 5, command: 'attachments:prune', consoleCommand: true },
    ])
    expect(formatUnknownCliCommand(unknown[0]!)).toContain('bun run console attachments:prune')
  })

  test('reports a command nothing registers', async () => {
    const unknown = await auditMarkdown('```bash\nbunx guren db:migrate:status\n```\n')

    expect(unknown.map(({ command, consoleCommand }) => ({ command, consoleCommand }))).toEqual([
      { command: 'db:migrate:status', consoleCommand: false },
    ])
  })

  test('accepts builtins, plugin commands, and placeholders', async () => {
    const unknown = await auditMarkdown(
      [
        'bunx guren db:status',
        'bunx guren cloudflare:build',
        'bunx guren make:<name>',
        'Every `bunx guren make:*` generator writes one file.',
        "schedule.command('bunx guren queue:work')",
      ].join('\n'),
    )

    expect(unknown).toEqual([])
  })

  test('accepts an example command the same page declares in a plugin manifest', async () => {
    const markdown = [
      '```json',
      '{ "gurenPlugin": { "commands": { "entry": "./dist/commands.js", "names": ["analytics:flush"] } } }',
      '```',
      'Now `bunx guren analytics:flush` runs it.',
    ].join('\n')

    expect(await auditMarkdown(markdown)).toEqual([])
    expect((await auditMarkdown('`bunx guren analytics:flush`')).map((entry) => entry.command)).toEqual(['analytics:flush'])
  })

  test('the docs tree names only registered commands', async () => {
    const unknown = await auditDocsCliCommands(repoRoot)

    expect(unknown.map(formatUnknownCliCommand)).toEqual([])
  })
})
