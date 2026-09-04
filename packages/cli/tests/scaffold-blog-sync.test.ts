import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '../../..')

/**
 * Auth scaffold templates and the blog blueprint share files at two levels.
 * Byte-identical pairs are pinned in lockstep below — a maintained invariant
 * (#380 and #393 each moved both sides in one commit; #297 is the drift bug
 * class). Near-twins (AuthProvider.ts, Layout.tsx) differ deliberately and pin
 * only their shared snippet, via SHARE_INERTIA_AUTH_PROPS_SNIPPET in
 * make-auth.test.ts. Diverging a pair means moving it out of this list.
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
