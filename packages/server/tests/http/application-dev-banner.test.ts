import { describe, expect, it } from 'bun:test'

const FIXTURE = new URL('./application-dev-banner-fixture.ts', import.meta.url).pathname

async function runFixture(nodeEnv: string): Promise<string> {
  const child = Bun.spawn(['bun', 'run', FIXTURE], {
    env: { ...process.env, NODE_ENV: nodeEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])

  expect(await child.exited, stderr).toBe(0)
  return stdout
}

/**
 * `Application.logDevServerBanner()` stays synchronous while the banner module
 * is imported on demand, so a call made before anything loaded it prints once the
 * import settles, and a call under `NODE_ENV=production` never loads it. `listen()`
 * loads it before calling, which `application-listen-port.test.ts` covers.
 */
describe('Application.logDevServerBanner called directly', () => {
  it('prints the banner once the module loads, after the call returns', async () => {
    const stdout = await runFixture('development')

    expect(stdout).toContain('Guren v')
    expect(stdout).toContain('http://127.0.0.1:4321')
    expect(stdout.indexOf('CALLED')).toBeLessThan(stdout.indexOf('Guren v'))
  }, 30_000)

  it('prints nothing under NODE_ENV=production, where the module is never loaded', async () => {
    expect(await runFixture('production')).toBe('CALLED\n')
  }, 30_000)
})
