import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '../../..')

/**
 * Policy: auth scaffold templates and the blog blueprint share files at two
 * levels, pinned differently.
 *
 * - Byte-identical pairs are pinned in lockstep below. Their identity is a
 *   maintained invariant, not a coincidence: every commit that touched either
 *   side has applied the same change to both in that commit (#380 dropped the
 *   explicit Inertia url everywhere at once, #393 migrated zod .email() across
 *   both trees), and silent drift between the two is exactly the bug class
 *   #297 was (shareInertiaProps present in the blueprint, missing from the
 *   generator). Before this pin the sync was maintained by hand and nothing
 *   failed when it slipped.
 * - Near-twins (AuthProvider.ts, Layout.tsx) differ deliberately — the blog
 *   blueprint is a showcase app with its own nav and __APP_TITLE__ — so only
 *   their behaviour-critical shared snippet is pinned, by
 *   SHARE_INERTIA_AUTH_PROPS_SNIPPET in make-auth.test.ts.
 *
 * Diverging a pair below is legitimate, but must be deliberate: move it out of
 * this list, and if a behaviour-critical part stays shared, pin that part as a
 * snippet the way make-auth.test.ts does. examples/blog is out of scope — it
 * is a dogfood app that has already evolved past both trees.
 */
const LOCKSTEP_PAIRS = [
  'app/Http/Controllers/DashboardController.ts',
  'app/Http/Validators/LoginValidator.ts',
  'app/Http/Validators/RegisterValidator.ts',
  'resources/js/pages/dashboard/Index.tsx',
]

describe('auth scaffold templates stay in lockstep with the blog blueprint', () => {
  it.each(LOCKSTEP_PAIRS)('%s', async (relativePath) => {
    const scaffold = await readFile(
      join(repoRoot, 'packages/cli/templates/scaffold/auth', relativePath),
      'utf8',
    )
    const blueprint = await readFile(
      join(repoRoot, 'packages/create-app/templates/blog', relativePath),
      'utf8',
    )

    expect(scaffold).toBe(blueprint)
  })
})
