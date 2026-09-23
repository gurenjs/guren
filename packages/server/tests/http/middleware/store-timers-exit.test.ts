import { describe, expect, test } from 'bun:test'

const FIXTURE = `${import.meta.dir}/store-timers-exit-fixture.ts`

// Every sweep period here is 60s, so a process still alive at this deadline is
// being held open by the timer rather than by a slow start.
const EXIT_DEADLINE_MS = 10_000

async function runFixture(name: string): Promise<{ exitCode: number | null; signalCode: string | null; stdout: string }> {
  const child = Bun.spawn([process.execPath, FIXTURE, name], {
    stdout: 'pipe',
    stderr: 'inherit',
    timeout: EXIT_DEADLINE_MS,
    killSignal: 'SIGKILL',
  })
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return { exitCode: child.exitCode, signalCode: child.signalCode, stdout }
}

describe('in-memory store timers', () => {
  test.each([
    'rate-limit-middleware',
    'memory-rate-limit-store',
    'sliding-window-rate-limit-store',
    'memory-cache-store',
    'scheduler',
  ])('should let a process that built a %s exit on its own', async (name) => {
    expect(await runFixture(name)).toEqual({ exitCode: 0, signalCode: null, stdout: 'built\n' })
  }, EXIT_DEADLINE_MS + 5_000)
})
