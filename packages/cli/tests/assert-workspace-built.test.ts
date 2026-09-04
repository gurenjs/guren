import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SERVER_DIST_ENTRY, assertWorkspaceBuilt } from './helpers'

/**
 * The guard keeps an unbuilt checkout from reading as a verdict. CI always builds first,
 * so it only ever fires locally, where nothing would notice it had stopped firing.
 */
describe('assertWorkspaceBuilt', () => {
  it('names every missing artifact and the command that produces it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guren-built-guard-'))
    try {
      const present = join(dir, 'present.js')
      await writeFile(present, 'export {}\n', 'utf8')

      expect(() => assertWorkspaceBuilt([present, join(dir, 'gone.js'), join(dir, 'also-gone.js')])).toThrow(
        /build:clean[\s\S]*missing[\s\S]*gone\.js[\s\S]*also-gone\.js/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('passes when the artifact is on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guren-built-guard-ok-'))
    try {
      const artifact = join(dir, 'index.js')
      await writeFile(artifact, 'export {}\n', 'utf8')

      expect(() => assertWorkspaceBuilt([artifact])).not.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // A typo in the guarded path would make the guard unfalsifiable: it would pass on
  // every checkout, built or not.
  it('points at the built server entry the spawned CLI resolves through', () => {
    expect(SERVER_DIST_ENTRY).toEndWith('packages/server/dist/index.js')
    expect(() => assertWorkspaceBuilt([SERVER_DIST_ENTRY])).not.toThrow()
  })
})
