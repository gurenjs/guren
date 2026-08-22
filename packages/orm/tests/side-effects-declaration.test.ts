import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pins the `"sideEffects"` array in packages/orm/package.json to the files that
 * actually carry the side effect.
 *
 * `src/instance-guard.ts` detects a second copy of @guren/orm in one process —
 * the failure that otherwise shows up as "database has not been configured" on
 * models imported through the extra copy. It is imported for that effect alone,
 * so a bundler told the package is side-effect-free would drop it.
 *
 * The array form is what prevents that, but only while its entries name real
 * files, and that is the part nothing else checks. `./dist/instance-guard.js`
 * looks like the obvious entry and is wrong: tsup inlines the guard into the
 * barrel, so that path matches nothing and the guard survives only by luck.
 * Making it a separate tsup entry does not help either — the guard then lands
 * in a content-hashed chunk no entry can name stably.
 *
 * A wrong path fails open in the worst way: everything builds, every test
 * passes, and the loss appears only in someone else's bundled app as a warning
 * that stopped being emitted.
 */

const ORM_ROOT = join(import.meta.dir, '..')
const GUARD_MARKER = 'guren.orm.loaded'

/** Reads a file, or returns null if it is absent — never a false "absent". */
function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const manifest = JSON.parse(readFileSync(join(ORM_ROOT, 'package.json'), 'utf8'))

describe('@guren/orm sideEffects declaration', () => {
  test('uses the array form, not a blanket false', () => {
    // `false` would license dropping instance-guard outright. Bun happens to
    // keep it anyway (it will not treat the guard's top-level global write as
    // pure), which is exactly why this needs asserting rather than measuring:
    // rollup and webpack drop a bare-imported module from a side-effect-free
    // package by design, and no Guren gate bundles with either.
    expect(Array.isArray(manifest.sideEffects)).toBe(true)
  })

  test('the source guard is still imported for its side effect', () => {
    const guard = readIfPresent(join(ORM_ROOT, 'src/instance-guard.ts'))
    expect(guard).not.toBeNull()
    expect(guard).toContain(GUARD_MARKER)

    // If the barrel ever stops bare-importing it, the guard never runs at all
    // and the declaration below is protecting nothing.
    const barrel = readFileSync(join(ORM_ROOT, 'src/index.ts'), 'utf8')
    expect(barrel).toMatch(/^\s*import\s+['"]\.\/instance-guard['"]/m)
  })

  test('every declared entry names a file that carries the guard', () => {
    const wrong: string[] = []

    // Whether dist was built at all, decided once from the barrel rather than
    // per entry. Skipping each missing dist file individually is fail-open: it
    // is precisely how `./dist/instance-guard.js` — a path tsup never emits —
    // would read as "not built yet" and pass forever.
    const distBuilt = readIfPresent(join(ORM_ROOT, 'dist/index.js')) !== null

    for (const entry of manifest.sideEffects as string[]) {
      // Globs would need matching rather than reading; none are used today and
      // one would silently skip this check, so it is called out instead.
      expect(entry).not.toContain('*')

      const isDist = entry.startsWith('./dist/')
      // A fresh checkout has no dist/ until `bun run build`; that is the only
      // reason to skip. Once dist exists, a declared dist file that does not is
      // the bug this test is for.
      if (isDist && !distBuilt) continue

      const contents = readIfPresent(join(ORM_ROOT, entry))
      if (contents === null) {
        wrong.push(`${entry}: no such file${isDist ? ' (dist is built, so this entry matches nothing)' : ''}`)
        continue
      }
      if (!contents.includes(GUARD_MARKER)) wrong.push(`${entry}: built, but does not carry the guard`)
    }

    expect(
      wrong,
      wrong.length === 0
        ? ''
        : `packages/orm/package.json "sideEffects" names entries that do not carry ` +
            `instance-guard:\n  ${wrong.join('\n  ')}\n` +
            `An entry matching nothing silently stops protecting the duplicate-copy warning in ` +
            `bundled apps. tsup inlines the guard into dist/index.js, so that — not ` +
            `dist/instance-guard.js — is the dist entry.`,
    ).toEqual([])
  })
})
