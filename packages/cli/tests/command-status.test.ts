import { describe, expect, test } from 'bun:test'
import { markCommandFailed } from '../src/command-status'
import { defineCommand } from '../src/define-command'
import { runCli } from '../src/run-cli'

describe('command status isolation', () => {
  test('returns failure after output and cleanup without changing the process exit code', async () => {
    const previous = process.exitCode
    const events: string[] = []
    const command = defineCommand({
      async run() {
        try {
          markCommandFailed()
          await Promise.resolve()
          events.push('report')
        } finally {
          events.push('cleanup')
        }
      },
    })
    expect(await runCli(command, [])).toBe(1)
    expect(events).toEqual(['report', 'cleanup'])
    expect(process.exitCode).toBe(previous)
    expect(await runCli(defineCommand({ run() {} }), [])).toBe(0)
  })

  test('nested calls return independent results', async () => {
    const command = defineCommand({
      async run() {
        expect(await runCli(defineCommand({ run: markCommandFailed }), [])).toBe(1)
        expect(await runCli(defineCommand({ run() {} }), [])).toBe(0)
      },
    })
    expect(await runCli(command, [])).toBe(0)
  })

  test('overlapping calls do not share failure state', async () => {
    const failing = Promise.withResolvers<void>()
    const successful = Promise.withResolvers<void>()
    const first = runCli(defineCommand({
      async run() {
        markCommandFailed()
        failing.resolve()
        await successful.promise
      },
    }), [])
    const second = runCli(defineCommand({
      async run() {
        await failing.promise
        successful.resolve()
      },
    }), [])
    expect(await Promise.all([first, second])).toEqual([1, 0])
  })
})
