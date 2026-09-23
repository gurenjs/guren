import { describe, expect, test } from 'bun:test'

const FIXTURE = `${import.meta.dir}/health-timer-exit-fixture.ts`

// The fixture's check timeout is 60s, so a process still alive at this deadline
// is being held open by the timeout timer rather than by a slow start.
const EXIT_DEADLINE_MS = 10_000

describe('health check timeout timer', () => {
  test('should let a process that ran one passing check exit on its own', async () => {
    const child = Bun.spawn([process.execPath, FIXTURE], {
      stdout: 'pipe',
      stderr: 'inherit',
      timeout: EXIT_DEADLINE_MS,
      killSignal: 'SIGKILL',
    })
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited])

    expect({ exitCode: child.exitCode, signalCode: child.signalCode, stdout }).toEqual({
      exitCode: 0,
      signalCode: null,
      stdout: 'healthy\n',
    })
  }, EXIT_DEADLINE_MS + 5_000)
})
