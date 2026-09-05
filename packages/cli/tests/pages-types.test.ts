import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  API_ONLY_REFUSAL,
  assertWorkspaceBuilt,
  BLOG_ROUTES_FIXTURE,
  CLI_BIN_PATH,
  createTempWorkspace,
  PAGE_COMPONENT_FIXTURE as PAGE_FIXTURE,
  seedApiOnlyApp,
  SERVER_DIST_ENTRY,
  writeWorkspaceFiles,
} from './helpers'
import {
  buildPageModuleContent,
  describePageManifestSuppression,
  generatePageTypes,
  planPageManifest,
  type PageDefinition,
} from '../src/pages-types'

const DEFAULT_PATHS = { pagesDir: 'resources/js/pages', manifestPath: '.guren/pages.gen.ts' }

describe('buildPageModuleContent', () => {
  it('generates a runtime manifest and nested page contracts', () => {
    const definitions: PageDefinition[] = [
      { id: 'Home', path: './pages/Home.tsx' },
      { id: 'auth/Login', path: './pages/auth/Login.tsx' },
      { id: 'posts/Index', path: './pages/posts/Index.tsx' },
    ]

    const content = buildPageModuleContent(definitions, { source: 'resources/js/pages' })

    expect(content).toContain("import type { PageContract, PagePropsRecord } from '@guren/inertia-client'")
    expect(content).toContain("'Home': './pages/Home.tsx'")
    expect(content).toContain("'auth/Login': './pages/auth/Login.tsx'")
    expect(content).toContain("Home: defineGeneratedPage('Home', pageManifest['Home'])")
    expect(content).toContain("Login: defineGeneratedPage('auth/Login', pageManifest['auth/Login'])")
    expect(content).toContain("Index: defineGeneratedPage('posts/Index', pageManifest['posts/Index'])")
  })
})

describe('generatePageTypes overwrite behavior', () => {
  // .guren/*.gen.ts are generated artifacts, so `codegenCommand` (src/bin.ts)
  // defaults `force: true`; without it a plain second `guren codegen` fails with
  // "already exists. Use --force to overwrite."
  it('fails without force when the output file already exists (safety net preserved)', async () => {
    const workspace = await createTempWorkspace('guren-cli-pages-types-noforce-')
    try {
      await mkdir(join(workspace.dir, 'resources/js/pages'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'resources/js/pages/Home.tsx'),
        'export default function Home() { return null }\n',
        'utf8',
      )
      await mkdir(join(workspace.dir, '.guren'), { recursive: true })
      await writeFile(join(workspace.dir, '.guren/pages.gen.ts'), '// stale generated content\n', 'utf8')

      await expect(
        generatePageTypes({ appRoot: workspace.dir, extractProps: false }),
      ).rejects.toThrow(/already exists/)
    } finally {
      await workspace.cleanup()
    }
  })

  it('overwrites an existing generated file when force is true, as codegen defaults', async () => {
    const workspace = await createTempWorkspace('guren-cli-pages-types-force-')
    try {
      await mkdir(join(workspace.dir, 'resources/js/pages'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'resources/js/pages/Home.tsx'),
        'export default function Home() { return null }\n',
        'utf8',
      )
      await mkdir(join(workspace.dir, '.guren'), { recursive: true })
      await writeFile(join(workspace.dir, '.guren/pages.gen.ts'), '// stale generated content\n', 'utf8')

      const { outputPath } = await generatePageTypes({
        appRoot: workspace.dir,
        extractProps: false,
        force: true,
      })

      const content = await readFile(outputPath, 'utf8')
      expect(content).not.toContain('stale generated content')
      expect(content).toContain("'Home': './pages/Home.tsx'")
    } finally {
      await workspace.cleanup()
    }
  })

  // Covers `codegenCommand` itself, not just the generator it calls: the tests
  // above pass `force` explicitly either way, so they would stay green even if
  // the command stopped forcing it.
  it('codegen CLI command overwrites existing artifacts on a second run without --force', async () => {
    const workspace = await createTempWorkspace('guren-cli-codegen-command-')
    try {
      await mkdir(join(workspace.dir, 'resources/js/pages'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'resources/js/pages/Home.tsx'),
        'export default function Home() { return null }\n',
        'utf8',
      )

      assertWorkspaceBuilt([SERVER_DIST_ENTRY])

      const runCodegen = () =>
        Bun.spawn(['bun', CLI_BIN_PATH, 'codegen', '--app', workspace.dir], {
          stdout: 'pipe',
          stderr: 'pipe',
        })

      const first = runCodegen()
      expect(await first.exited).toBe(0)

      // No routes/web.ts here, so the command writes pages.gen.ts and exits 0 —
      // the bug's write path without needing a full routes/schema fixture.
      const second = runCodegen()
      const secondExitCode = await second.exited
      const secondStderr = await new Response(second.stderr).text()

      expect(secondExitCode).toBe(0)
      expect(secondStderr).not.toContain('already exists')

      const content = await readFile(join(workspace.dir, '.guren/pages.gen.ts'), 'utf8')
      expect(content).toContain("'Home': './pages/Home.tsx'")
    } finally {
      await workspace.cleanup()
    }
  }, 20000)
})

/**
 * Page components can reach an API-only app by routes no scaffolder controls,
 * and the api blueprint's `dev` script runs codegen. The manifest would import
 * `@guren/inertia-client`, which that app does not install, inside a `.guren/**`
 * its tsconfig type-checks.
 */
describe('generatePageTypes on an API-only app', () => {
  it('writes no manifest and says why', async () => {
    const workspace = await createTempWorkspace('guren-cli-pages-api-only-')
    try {
      await seedApiOnlyApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'resources/js/pages/Home.tsx': PAGE_FIXTURE })

      const { outputPath, plan, skipped } = await generatePageTypes({
        appRoot: workspace.dir,
        extractProps: false,
        force: true,
      })

      expect(outputPath).toBe('')
      expect(plan).toEqual({ ...DEFAULT_PATHS, reason: 'api-only', pageCount: 1, staleManifest: false })
      expect(existsSync(join(workspace.dir, '.guren/pages.gen.ts'))).toBe(false)
      // Carried on the result so a caller that only sees the return value — the
      // MCP codegen tool — can say more than "nothing to generate".
      expect(skipped?.message).toMatch(API_ONLY_REFUSAL)
    } finally {
      await workspace.cleanup()
    }
  })

  // Deliberate: if the rule is ever wrong about an app, deleting the manifest
  // turns a type error into a mystery. `check` and `doctor` report the leftover.
  it('leaves a manifest generated before the app took this shape on disk', async () => {
    const workspace = await createTempWorkspace('guren-cli-pages-api-only-stale-')
    try {
      await seedApiOnlyApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, {
        'resources/js/pages/Home.tsx': PAGE_FIXTURE,
        '.guren/pages.gen.ts': '// generated when this app still had a client\n',
      })

      const { plan } = await generatePageTypes({ appRoot: workspace.dir, extractProps: false, force: true })

      expect(plan.staleManifest).toBe(true)
      const content = await readFile(join(workspace.dir, '.guren/pages.gen.ts'), 'utf8')
      expect(content).toContain('generated when this app still had a client')
    } finally {
      await workspace.cleanup()
    }
  })

  // The page components are what put the manifest there, but they are not what
  // keeps failing the typecheck — deleting them again leaves the import behind.
  it('still reports a leftover manifest once the page components are gone', async () => {
    const workspace = await createTempWorkspace('guren-cli-pages-api-only-orphan-')
    try {
      await seedApiOnlyApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { '.guren/pages.gen.ts': '// orphaned\n' })

      const plan = await planPageManifest(workspace.dir)
      const suppressed = describePageManifestSuppression(plan)

      expect(plan).toEqual({ ...DEFAULT_PATHS, reason: 'api-only', pageCount: 0, staleManifest: true })
      expect(suppressed?.message).toContain('.guren/pages.gen.ts is present but codegen would not write it')
      expect(suppressed?.message).not.toContain('page component')
      expect(suppressed?.advisory).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  // Keeps the skip from degenerating into "any app whose package.json does not
  // name @guren/inertia-client": one web routes entry is enough evidence.
  it('still writes the manifest once the app has a web routes entry', async () => {
    const workspace = await createTempWorkspace('guren-cli-pages-fullstack-')
    try {
      await seedApiOnlyApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, {
        'resources/js/pages/Home.tsx': PAGE_FIXTURE,
        'routes/web.ts': BLOG_ROUTES_FIXTURE,
      })

      const { outputPath, plan, skipped } = await generatePageTypes({
        appRoot: workspace.dir,
        extractProps: false,
        force: true,
      })

      expect(plan).toEqual({ ...DEFAULT_PATHS, reason: 'pages', pageCount: 1, staleManifest: false })
      expect(skipped).toBeNull()
      expect(outputPath).toBe(join(workspace.dir, '.guren/pages.gen.ts'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports the same plan through planPageManifest, which check and doctor read', async () => {
    const workspace = await createTempWorkspace('guren-cli-pages-plan-')
    try {
      await seedApiOnlyApp(workspace.dir)

      const empty = await planPageManifest(workspace.dir)
      expect(empty).toEqual({ ...DEFAULT_PATHS, reason: 'no-pages', pageCount: 0, staleManifest: false })
      expect(describePageManifestSuppression(empty)).toBeNull()

      await writeWorkspaceFiles(workspace.dir, { 'resources/js/pages/Home.tsx': PAGE_FIXTURE })

      expect(await planPageManifest(workspace.dir)).toEqual({
        ...DEFAULT_PATHS,
        reason: 'api-only',
        pageCount: 1,
        staleManifest: false,
      })
    } finally {
      await workspace.cleanup()
    }
  })

  // --pages / --pages-out move both files, and a report naming the defaults
  // would send the user looking in directories this run never touched.
  it('names the directories the run actually used', async () => {
    const workspace = await createTempWorkspace('guren-cli-pages-custom-paths-')
    try {
      await seedApiOnlyApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'frontend/screens/Home.tsx': PAGE_FIXTURE })

      const { plan } = await generatePageTypes({
        appRoot: workspace.dir,
        pagesDir: 'frontend/screens',
        outputFile: 'generated/client-pages.ts',
        extractProps: false,
        force: true,
      })

      expect(describePageManifestSuppression(plan)?.message).toBe(
        '1 page component under frontend/screens, but this app has no @guren/inertia-client dependency '
        + 'and no routes/web.ts, so codegen writes no generated/client-pages.ts.',
      )
    } finally {
      await workspace.cleanup()
    }
  })

  // The skip has to be audible. A user whose app was misread as API-only sees
  // this line in place of "Page helpers generated at …".
  it('warns from the codegen command rather than skipping silently', async () => {
    const workspace = await createTempWorkspace('guren-cli-pages-api-only-cli-')
    try {
      await seedApiOnlyApp(workspace.dir)
      await writeWorkspaceFiles(workspace.dir, { 'resources/js/pages/Home.tsx': PAGE_FIXTURE })

      assertWorkspaceBuilt([SERVER_DIST_ENTRY])

      const proc = Bun.spawn(['bun', CLI_BIN_PATH, 'codegen', '--app', workspace.dir], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`

      expect(exitCode).toBe(0)
      expect(output).toMatch(API_ONLY_REFUSAL)
      expect(output).not.toContain('Page helpers generated at')
      expect(existsSync(join(workspace.dir, '.guren/pages.gen.ts'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  }, 20000)
})
