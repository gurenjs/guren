import { afterEach, beforeEach } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

export interface AssetFixture {
  /** Absolute path of the directory created for the running test. */
  readonly root: string
  /** Absolute path of `segments` inside the fixture root. */
  path(...segments: string[]): string
  /** Create a directory (and its parents). Returns its absolute path. */
  mkdir(relativePath: string): Promise<string>
  /** Write a file, creating parent directories. Returns its absolute path. */
  write(relativePath: string, contents: string): Promise<string>
  /** Link `linkPath` to `targetPath`, both relative to the fixture root. */
  symlink(targetPath: string, linkPath: string): void
}

/**
 * A throwaway directory per test, for the asset handlers that judge containment.
 * The root is canonicalized because `os.tmpdir()` is itself a symlink on macOS
 * (`/var` → `/private/var`), which a containment assertion would otherwise report
 * instead of the handler. Call from a `describe` body, above the `beforeEach` that
 * populates it — Bun runs hooks in registration order.
 */
export function useAssetFixture(prefix: string): AssetFixture {
  let root: string | undefined

  function fixturePath(...segments: string[]): string {
    if (!root) {
      throw new Error('Asset fixture used outside a test; call useAssetFixture() from a describe body.')
    }

    return join(root, ...segments)
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  })

  afterEach(() => {
    // Teardown should never be what reports a fixture that was never set up.
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }

    root = undefined
  })

  return {
    get root(): string {
      return fixturePath()
    },
    path: fixturePath,
    async mkdir(relativePath: string): Promise<string> {
      const target = fixturePath(relativePath)
      await mkdir(target, { recursive: true })
      return target
    },
    async write(relativePath: string, contents: string): Promise<string> {
      const target = fixturePath(relativePath)
      await mkdir(dirname(target), { recursive: true })
      await Bun.write(target, contents)
      return target
    },
    symlink(targetPath: string, linkPath: string): void {
      symlinkSync(fixturePath(targetPath), fixturePath(linkPath))
    },
  }
}
