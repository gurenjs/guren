import { describe, expect, test } from 'bun:test'

const FIXTURE = new URL('./store-timers-exit-fixture.ts', import.meta.url).pathname

// Every sweep period here is 60s, so a process still alive at this deadline is
// being held open by the timer rather than by a slow start.
const EXIT_DEADLINE_MS = 10_000

async function runFixture(name: string): Promise<{ exited: boolean; exitCode: number | null; stdout: string }> {
  const child = Bun.spawn(['bun', FIXTURE, name], { stdout: 'pipe', stderr: 'inherit' })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const exited = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), EXIT_DEADLINE_MS)
      }),
    ])
    if (!exited) {
      child.kill('SIGKILL')
      await child.exited
    }
    return { exited, exitCode: child.exitCode, stdout: await new Response(child.stdout).text() }
  } finally {
    clearTimeout(timer)
  }
}

describe('in-memory store timers', () => {
  test.each([
    'rate-limit-middleware',
    'memory-rate-limit-store',
    'sliding-window-rate-limit-store',
    'memory-cache-store',
    'scheduler',
  ])('should let a process that built a %s exit on its own', async (name) => {
    const result = await runFixture(name)

    expect(result.stdout).toBe('built\n')
    expect(result.exited).toBe(true)
    expect(result.exitCode).toBe(0)
  }, EXIT_DEADLINE_MS + 5_000)
})
