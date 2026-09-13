import { beforeAll, describe, expect, test } from 'bun:test'

import {
  formatUnknownCliCommand,
  knownCliCommands,
  unknownCommandsIn,
  type KnownCliCommands,
} from './docs-cli-commands'

let known: KnownCliCommands

beforeAll(async () => {
  known = await knownCliCommands()
})

function unknownIn(...lines: string[]) {
  return unknownCommandsIn(lines.join('\n'), 'page.md', known)
}

describe('knownCliCommands', () => {
  test('registers builtins and first-party plugin commands, not app console commands', () => {
    expect(known.registered.has('db:status')).toBe(true)
    expect(known.registered.has('cloudflare:build')).toBe(true)
    expect(known.registered.has('attachments:prune')).toBe(false)
  })

  test('finds the console commands the framework ships', () => {
    expect(known.consoleCommands.has('attachments:prune')).toBe(true)
  })
})

describe('unknownCommandsIn', () => {
  test('reports an app console command spelled as a CLI command, in a fence and inline', () => {
    const unknown = unknownIn('```bash', 'bunx guren attachments:prune --dry-run', '```', '', 'Then `bunx guren attachments:prune` finds them.')

    expect(unknown.map(({ line, command, consoleCommand }) => ({ line, command, consoleCommand }))).toEqual([
      { line: 2, command: 'attachments:prune', consoleCommand: true },
      { line: 5, command: 'attachments:prune', consoleCommand: true },
    ])
    expect(formatUnknownCliCommand(unknown[0]!)).toContain('bun run console attachments:prune')
  })

  test('reports a command nothing registers', () => {
    expect(unknownIn('bunx guren db:migrate:status').map(({ command, consoleCommand }) => ({ command, consoleCommand }))).toEqual([
      { command: 'db:migrate:status', consoleCommand: false },
    ])
  })

  test('accepts builtins, plugin commands, and placeholders', () => {
    const unknown = unknownIn(
      'bunx guren db:status',
      'bunx guren cloudflare:build',
      'bunx guren make:<name>',
      'Every `bunx guren make:*` generator writes one file.',
      "schedule.command('bunx guren queue:work')",
    )

    expect(unknown).toEqual([])
  })

  test('accepts an example command only on the page that declares it in a plugin manifest', () => {
    const manifest = '{ "gurenPlugin": { "commands": { "entry": "./dist/commands.js", "names": ["analytics:flush"] } } }'

    expect(unknownIn('```json', manifest, '```', 'Now `bunx guren analytics:flush` runs it.')).toEqual([])
    expect(unknownIn('`bunx guren analytics:flush`').map((entry) => entry.command)).toEqual(['analytics:flush'])
  })
})
