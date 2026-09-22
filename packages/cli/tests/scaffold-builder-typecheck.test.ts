import { describe, expect, it } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkTypes, TSC_TIMEOUT, createTempWorkspace, renderedAppCompilerOptions, seedInertiaApp, writeWorkspaceFiles } from './helpers'
import { collectFiles, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES, toPosixRelative } from '../src/discovery'
import { makeAuth, type MakeAuthOptions } from '../src/make-auth'
import { generatePageTypes } from '../src/pages-types'

/**
 * The compile gate for make:auth's *builder* output: flag-dependent
 * `build*Template()` code exists only at generation time, so a type error in a
 * branch survives the parse gate. Renders flag combinations into a workspace,
 * regenerates `.guren/pages.gen.ts`, and typechecks the lot as one program. The
 * three combos (oauth+verify, oauth, oauth-only) reach every builder branch.
 */

const cliRoot = join(import.meta.dir, '..')

/**
 * Proves the pages.gen mapping resolved to the *typed* module: a broken alias
 * would fail loudly, but an `any`-shaped one passes until TS2578 here.
 */
const PAGES_PROBE = `import { pages } from '@/.guren/pages.gen'

export const login = pages.auth.Login
// @ts-expect-error a page this combo never scaffolded must not typecheck
export const missing = pages.auth.NotAPage
`

// An app declaring its environment gets the config definitions (RFC 0027 §2), which read AppEnv.
const DECLARED_ENV = join(cliRoot, '../create-app/templates/default/config/env.ts')

const compiledCombos: Array<[string, MakeAuthOptions, string[], boolean?]> = [
  [
    'oauth-verify',
    { oauth: 'github', verify: true },
    ['app/Http/Controllers/Auth/RegisterController.ts', 'db/seeders/UsersSeeder.ts'],
  ],
  [
    'oauth',
    { oauth: 'github,google,discord' },
    ['app/Http/Controllers/Auth/RegisterController.ts', 'app/Http/Controllers/ProfileController.ts'],
  ],
  [
    'oauth-only',
    { oauth: 'github,google', oauthOnly: true },
    ['app/Http/Controllers/ProfileController.ts', 'resources/js/pages/auth/Login.tsx'],
  ],
  [
    'oauth-verify-declared-env',
    { oauth: 'github,google', verify: true },
    ['config/oauth.ts', 'config/mail.ts'],
    true,
  ],
]

describe('rendered make:auth output typechecks', () => {
  for (const [label, options, expectedWrites, declaresEnv] of compiledCombos) {
    it(
      `make:auth ${label}`,
      async () => {
        const workspace = await createTempWorkspace(`guren-typecheck-auth-${label}-`)
        try {
          await seedInertiaApp(workspace.dir)
          if (declaresEnv) await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': await readFile(DECLARED_ENV, 'utf8') })
          // Relative to cwd, not workspace.dir: the macOS tmpdir is a
          // symlink (/var → /private/var), and makeAuth reports the realpath.
          const created = (await makeAuth({ ...options, force: true })).map((file) =>
            toPosixRelative(process.cwd(), file))
          for (const path of expectedWrites) {
            expect(created).toContain(path)
          }

          await generatePageTypes({ appRoot: workspace.dir, extractProps: true })
          await writeFile(join(workspace.dir, 'pages-probe.ts'), PAGES_PROBE, 'utf8')

          const rootNames = await collectFiles(workspace.dir, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES)
          // Everything the scaffold wrote must reach the program; a walk that
          // skipped the generated subtrees would be green for the wrong reason.
          const collected = rootNames.map((file) => toPosixRelative(workspace.dir, file))
          for (const path of created) {
            expect(collected).toContain(path)
          }

          expect(checkTypes(rootNames, renderedAppCompilerOptions(workspace.dir))).toEqual([])
        } finally {
          await workspace.cleanup()
        }
      },
      TSC_TIMEOUT,
    )
  }
})
