import { describe, expect, it } from 'bun:test'

const FIXTURE = `${import.meta.dir}/application-dev-banner-fixture.ts`

const EXIT_DEADLINE_MS = 10_000

async function runFixture(nodeEnv: string): Promise<string> {
  const child = Bun.spawn([process.execPath, FIXTURE], {
    env: { ...process.env, NODE_ENV: nodeEnv },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: EXIT_DEADLINE_MS,
    killSignal: 'SIGKILL',
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])

  expect(await child.exited, stderr).toBe(0)
  return stdout
}

// `listen()` preloads the module; `application-listen-port.test.ts` covers that path.
describe('Application.logDevServerBanner called directly', () => {
  it('prints the banner once the module loads, after the call returns', async () => {
    const stdout = await runFixture('development')

    expect(stdout).toContain('Guren v')
    expect(stdout).toContain('http://127.0.0.1:4321')
    expect(stdout.indexOf('CALLED')).toBeLessThan(stdout.indexOf('Guren v'))
  }, EXIT_DEADLINE_MS + 5_000)

  it('prints nothing under NODE_ENV=production, where the module is never loaded', async () => {
    expect(await runFixture('production')).toBe('CALLED\n')
  }, EXIT_DEADLINE_MS + 5_000)
})
