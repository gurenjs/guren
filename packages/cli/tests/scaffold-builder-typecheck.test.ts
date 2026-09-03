import { describe, expect, it } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkTypes, TSC_TIMEOUT, createTempWorkspace, resolvedCompilerOptions, seedInertiaApp, type TsconfigCompilerOptions } from './helpers'
import { collectFiles, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES, toPosixRelative } from '../src/discovery'
import { makeAuth, type MakeAuthOptions } from '../src/make-auth'
import { generatePageTypes } from '../src/pages-types'

/**
 * The compile gate for make:auth's *builder* output: flag-dependent
 * `build*Template()` code exists nowhere until generation time, so a type error
 * in a branch survives the parse gate and reaches a user's editor first. Renders
 * flag combinations into a workspace, regenerates `.guren/pages.gen.ts`, and
 * typechecks the lot as one program. The three combos here (oauth+verify, oauth,
 * oauth-only) reach every builder branch; the rest differ only by omission.
 */

const cliRoot = join(import.meta.dir, '..')

/**
 * The options of tsconfig.templates.json, pointed at a rendered workspace.
 * Loaded from the config rather than restated so this gate and
 * `typecheck:templates` cannot drift. The three overrides are all consequences
 * of the render living outside the repo: `@/.guren/pages.gen` moves to this
 * render's generated file, bare imports resolve to this package's dependencies,
 * and the root config's `types: ["bun-types"]` gives way to node's globals.
 */
function renderedScaffoldCompilerOptions(workspaceDir: string): TsconfigCompilerOptions {
  const parsed = resolvedCompilerOptions(join(cliRoot, 'tsconfig.templates.json'))

  return {
    ...parsed,
    // The two fixture dirs the static gate overlays; meaningless here.
    rootDirs: undefined,
    typeRoots: [join(cliRoot, '../../node_modules'), join(cliRoot, 'node_modules/@types')],
    types: ['bun-types', 'node'],
    paths: {
      ...parsed.paths,
      '@/.guren/pages.gen': [join(workspaceDir, '.guren/pages.gen.ts')],
      zod: [join(cliRoot, 'node_modules/zod')],
      '@inertiajs/react': [join(cliRoot, 'node_modules/@inertiajs/react')],
      react: [join(cliRoot, 'node_modules/@types/react/index.d.ts')],
      'react/jsx-runtime': [join(cliRoot, 'node_modules/@types/react/jsx-runtime.d.ts')],
    },
  }
}

/**
 * Proves the pages.gen mapping resolved to the *typed* module: a broken alias
 * would fail loudly, but an `any`-shaped one passes until TS2578 here.
 */
const PAGES_PROBE = `import { pages } from '@/.guren/pages.gen'

export const login = pages.auth.Login
// @ts-expect-error a page this combo never scaffolded must not typecheck
export const missing = pages.auth.NotAPage
`

const compiledCombos: Array<[string, MakeAuthOptions, string[]]> = [
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
]

describe('rendered make:auth output typechecks', () => {
  for (const [label, options, expectedWrites] of compiledCombos) {
    it(
      `make:auth ${label}`,
      async () => {
        const workspace = await createTempWorkspace(`guren-typecheck-auth-${label}-`)
        try {
          await seedInertiaApp(workspace.dir)
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

          expect(checkTypes(rootNames, renderedScaffoldCompilerOptions(workspace.dir))).toEqual([])
        } finally {
          await workspace.cleanup()
        }
      },
      TSC_TIMEOUT,
    )
  }
})
