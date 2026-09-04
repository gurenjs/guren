import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  CLI_BIN_PATH,
  CORE_RESOLVING_ROUTES_FIXTURE,
  SERVER_DIST_ENTRY,
  assertWorkspaceBuilt,
  createTempWorkspace,
} from './helpers'

/**
 * Keeps this package's fixtures measuring the checkout instead of the machine:
 * `createTempWorkspace` writes a bunfig disabling Bun's auto-install fallback
 * into every fixture, and these tests go red when it stops doing so.
 */
describe('temp-directory fixtures cannot reach an ambient @guren/core', () => {
  it('gives a spawned CLI no way to resolve an unlinked fixture', async () => {
    assertWorkspaceBuilt([SERVER_DIST_ENTRY])
    const workspace = await createTempWorkspace('guren-cli-resolution-guard-')

    try {
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      await writeFile(join(workspace.dir, 'routes/web.ts'), CORE_RESOLVING_ROUTES_FIXTURE, 'utf8')

      const proc = Bun.spawn(['bun', CLI_BIN_PATH, 'context'], {
        cwd: workspace.dir,
        stdout: 'pipe',
        stderr: 'ignore',
      })
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])

      expect(exitCode).toBe(0)
      // The *reason* is the assertion: without the bunfig the fixture still
      // fails, but with "resolved a different @guren/core" — only a resolution
      // failure proves nothing ambient was reachable. Matched loosely because
      // the wording is Bun's and already moved once (1.3.14 "Cannot find
      // module", 1.4.0 "Cannot find package").
      expect(stdout).toMatch(/Cannot find (module|package) '@guren\/core'/u)
      expect(stdout).not.toContain('resolved a different @guren/core')
      expect(stdout).not.toContain('posts.index')
    } finally {
      await workspace.cleanup()
    }
  })

  it('carries the setting that disables auto-install, on any machine', async () => {
    // The test above passes with the fix reverted wherever no ambient copy is
    // reachable (empty Bun cache, no registry). This one fails the moment the
    // setting stops being written, whatever the machine.
    const workspace = await createTempWorkspace('guren-cli-resolution-guard-config-')

    try {
      const bunfig = await readFile(join(workspace.dir, 'bunfig.toml'), 'utf8')
      expect(bunfig).toContain('[install]')
      expect(bunfig).toMatch(/auto\s*=\s*"disable"/u)
    } finally {
      await workspace.cleanup()
    }
  })

  it('needs no equivalent in this process: an unlinked fixture is not importable', async () => {
    // A canary, not a guard. `bun run` auto-installs and `bun test` does not
    // (Bun 1.3.14, verified with no bunfig anywhere), so only the processes
    // these tests spawn need the fixture bunfig. It catches a future Bun that
    // auto-installs under the test runner.
    const dir = await mkdtemp(join(tmpdir(), 'guren-cli-resolution-canary-'))

    try {
      await writeFile(join(dir, 'fixture.ts'), CORE_RESOLVING_ROUTES_FIXTURE, 'utf8')

      const outcome = await import(join(dir, 'fixture.ts')).then(() => 'resolved', () => 'blocked')
      expect(outcome).toBe('blocked')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
