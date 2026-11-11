import { beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { makeAuth } from '../src/make-auth'

const repoRoot = join(import.meta.dir, '../../..')
const blogTemplate = join(repoRoot, 'packages/create-app/templates/blog')

/**
 * Auth scaffold templates and the blog blueprint share files at two levels.
 * Byte-identical pairs are pinned in lockstep below (#380 and #393 each moved
 * both sides in one commit; #297 is the drift bug class). Near-twins
 * (AuthProvider.ts, Layout.tsx) differ deliberately and pin only their shared
 * snippet, via SHARE_INERTIA_AUTH_PROPS_SNIPPET in make-auth.test.ts.
 */
const LOCKSTEP_PAIRS = [
  'app/Http/Controllers/DashboardController.ts',
  'app/Http/Middleware/AuthThrottle.ts',
  'app/Http/Validators/LoginValidator.ts',
  'app/Http/Validators/RegisterValidator.ts',
  'resources/js/pages/dashboard/Index.tsx',
]

// make:auth builds these from flags, so they have no template file to pair with.
// The current-password gate on PUT /profile lives in them: a blog copy that
// drifts lets a session alone replace the account's credentials.
const RENDERED_LOCKSTEP_FILES = [
  'app/Http/Controllers/ProfileController.ts',
  'app/Http/Validators/ProfileValidator.ts',
  'resources/js/pages/profile/Edit.tsx',
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

describe('make:auth output stays in lockstep with the blog blueprint', () => {
  const rendered = new Map<string, string>()

  beforeAll(async () => {
    const workspace = await createTempWorkspace('guren-cli-blog-sync-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      await makeAuth({ force: true })

      for (const relativePath of RENDERED_LOCKSTEP_FILES) {
        rendered.set(relativePath, await readFile(join(workspace.dir, relativePath), 'utf8'))
      }
    } finally {
      await workspace.cleanup()
    }
  }, 60_000)

  it.each(RENDERED_LOCKSTEP_FILES)('%s', async (relativePath) => {
    const blueprint = await readFile(join(blogTemplate, relativePath), 'utf8')

    expect(rendered.get(relativePath)).toBe(blueprint)
  })

  // The blog's routes file diverges on purpose (alias groups), so only this line is pinned.
  it('throttles PUT /profile, which the current-password check depends on', async () => {
    const routes = await readFile(join(blogTemplate, 'routes/auth.ts'), 'utf8')

    expect(routes).toContain(
      "authed.put('/profile', { name: 'profile.update', body: ProfileUpdateSchema, middlewares: [throttleProfileUpdate] }, [ProfileController, 'update'])",
    )
  })
})
