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
 * The guard that keeps this package's fixtures measuring the checkout instead
 * of the machine, under test itself.
 *
 * `createTempWorkspace` writes a bunfig disabling Bun's auto-install fallback
 * into every fixture; its own comment records why, and what the fallback was
 * measured to resolve to. These are the two tests that go red when that stops
 * happening. The shared fixture they run
 * ({@link CORE_RESOLVING_ROUTES_FIXTURE}) is what makes them able to tell.
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
      // The *reason* is the assertion, not the failure. Drop the bunfig
      // `createTempWorkspace` writes and this fixture still fails to produce
      // routes — but with "resolved a different @guren/core", because it
      // bound the published package (verified by removing it). Only a
      // resolution failure proves nothing ambient was reachable.
      //
      // Matched loosely because the wording is Bun's, not ours, and it has
      // already moved once: 1.3.14 says `Cannot find module '@guren/core'
      // from …`, 1.4.0 says `Cannot find package '@guren/core' imported from
      // …`. Pinning the sentence made this fail on a runtime where the
      // behaviour under test was correct.
      expect(stdout).toMatch(/Cannot find (module|package) '@guren\/core'/u)
      expect(stdout).not.toContain('resolved a different @guren/core')
      expect(stdout).not.toContain('posts.index')
    } finally {
      await workspace.cleanup()
    }
  })

  it('carries the setting that disables auto-install, on any machine', async () => {
    // The behavioural test above only separates "guard present" from "guard
    // removed" where an ambient copy is actually reachable: on a runner with
    // an empty Bun cache and no registry, the fixture fails to resolve either
    // way and the assertion passes with the fix reverted. This one does not
    // depend on the machine at all — it fails the moment the setting stops
    // being written, which is the regression that would let the other test go
    // quietly blind.
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
    // (Bun 1.3.14, verified with no bunfig present anywhere), which is why
    // only the processes these tests *spawn* need the fixture bunfig, and why
    // no `[install]` setting is carried in the repo's own bunfig files. This
    // asserts the conclusion — an in-process fixture cannot reach an ambient
    // copy — rather than the mechanism, which it cannot distinguish from
    // "tried and failed". A future Bun that auto-installs under the test
    // runner would resolve here, and that is what this exists to catch.
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
