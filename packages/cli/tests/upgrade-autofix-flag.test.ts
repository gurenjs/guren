import { describe, test, expect } from 'bun:test'
import { runCommand } from 'citty'

import { builtinSubCommands, readNoAutofix } from '../src/commands'

/**
 * Both halves of the defect are driven with the real pieces: citty parses against
 * the command's own `args`, and the result goes through the same `readNoAutofix`.
 * `upgradeCommand.run` is not invoked because faking `upgradeCanary` needs
 * `mock.module`, which is process-wide and would leave `upgrade.test.ts`
 * asserting against the fake.
 */
async function noAutofixFor(rawArgs: string[]): Promise<boolean | undefined> {
  let captured: boolean | undefined
  await runCommand(
    {
      meta: { name: 'upgrade' },
      args: builtinSubCommands.upgrade.args,
      run: ({ args }) => {
        captured = readNoAutofix(args as { autofix?: boolean; noAutofix?: boolean })
      },
    },
    { rawArgs },
  )
  return captured
}

describe('upgrade --no-autofix', () => {
  test('leaves autofix on when the flag is absent', async () => {
    expect(await noAutofixFor([])).toBe(false)
  })

  test('turns autofix off for the kebab spelling citty negates', async () => {
    expect(await noAutofixFor(['--no-autofix'])).toBe(true)
  })

  test('turns autofix off for the camel spelling usage printed', async () => {
    expect(await noAutofixFor(['--noAutofix'])).toBe(true)
  })

  test('usage advertises the spelling that works', async () => {
    const args = builtinSubCommands.upgrade.args as Record<string, { type?: string; default?: unknown }>
    // citty prints `--no-<name>` only for a boolean defaulting to true.
    expect(args.autofix).toMatchObject({ type: 'boolean', default: true })
  })
})
