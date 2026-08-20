import { describe, expect, it } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ts from 'typescript'
import { checkTypes, COLD_TSC_TIMEOUT, createTempWorkspace, seedInertiaApp } from './helpers'
import { collectFiles, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES, toPosixRelative } from '../src/discovery'
import { makeAuth, type MakeAuthOptions } from '../src/make-auth'
import { generatePageTypes } from '../src/pages-types'

/**
 * The compile gate for make:auth's *builder* output. The static templates
 * under templates/scaffold/auth get `typecheck:templates`
 * (tsconfig.templates.json), and scaffold-output.test.ts parse-checks every
 * generator — but a flag-dependent `build*Template()` renders code that exists
 * nowhere until generation time, so a type error in a branch (a dropped
 * import, a model field the controller no longer has) survives parsing and
 * lands in a user's editor first. This renders whole flag combinations into a
 * workspace, regenerates `.guren/pages.gen.ts` the way `guren codegen` would,
 * and typechecks everything the scaffold wrote as one program.
 *
 * Two combos rather than the full authCombos matrix: each program compiles the
 * workspace packages from source and costs COLD_TSC_TIMEOUT-scale time, and
 * these two reach the builder branches the other combos can't:
 *
 *  - oauth + verify: password login with a validator import, register with
 *    verification, the verify-aware OAuth callback, the password profile, the
 *    seeder, and every mail/verification view.
 *  - oauth-only: the passwordless login controller, the provider-owned-email
 *    profile controller/validator/view, the OAuth-only login view, and a
 *    passwordless user model.
 *
 * Branches only the remaining combos hit (a no-OAuth login view, a register
 * view without provider buttons, `buildRegisterControllerTemplate(false)`)
 * differ from the compiled ones by omission, and stay covered by the parse
 * gate; the `--verify` render of the User model is compiled separately as the
 * scaffold-typecheck fixture.
 */

const cliRoot = join(import.meta.dir, '..')

/**
 * The options of tsconfig.templates.json, pointed at a rendered workspace.
 *
 * Loaded from the config rather than restated so this gate and
 * `typecheck:templates` can't drift apart on what "the auth scaffold
 * typechecks" means. Three overrides, all consequences of the render living
 * outside the repo (where the node_modules walk from an importing file finds
 * nothing):
 *
 *  - `@/.guren/pages.gen` moves from the checked-in fixture to the pages.gen
 *    generated for this render — the fixture describes the `--verify` combo
 *    only.
 *  - bare imports the rendered files make (`zod`, `@inertiajs/react`, the
 *    implicit `react/jsx-runtime` of jsx:react-jsx) are pinned to this
 *    package's own dependencies.
 *  - the root config's `types: ["bun-types"]` resolves from the compiler's
 *    cwd, which is the temp workspace here; the scaffold reaches for
 *    `process.env` and nothing else, so node's globals from this package's
 *    @types stand in.
 */
function renderedScaffoldCompilerOptions(workspaceDir: string): ts.CompilerOptions {
  const configPath = join(cliRoot, 'tsconfig.templates.json')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, ' '))
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, cliRoot)

  return {
    ...parsed.options,
    // The two fixture dirs the static gate overlays; meaningless here.
    rootDirs: undefined,
    typeRoots: [join(cliRoot, '../../node_modules'), join(cliRoot, 'node_modules/@types')],
    types: ['bun-types', 'node'],
    paths: {
      ...parsed.options.paths,
      '@/.guren/pages.gen': [join(workspaceDir, '.guren/pages.gen.ts')],
      zod: [join(cliRoot, 'node_modules/zod')],
      '@inertiajs/react': [join(cliRoot, 'node_modules/@inertiajs/react')],
      react: [join(cliRoot, 'node_modules/@types/react/index.d.ts')],
      'react/jsx-runtime': [join(cliRoot, 'node_modules/@types/react/jsx-runtime.d.ts')],
    },
  }
}

/**
 * Proves the pages.gen mapping resolved to the *typed* module: were the alias
 * broken every controller import would fail loudly, but a mapping that
 * resolved to something `any`-shaped would pass silently — until the accepted
 * probe surfaces as TS2578.
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
          // A gate over an empty file list is green for the wrong reason.
          expect(rootNames.length).toBeGreaterThan(expectedWrites.length)

          expect(checkTypes(rootNames, renderedScaffoldCompilerOptions(workspace.dir))).toEqual([])
        } finally {
          await workspace.cleanup()
        }
      },
      COLD_TSC_TIMEOUT,
    )
  }
})
