import { describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createTempWorkspace } from './helpers'
import { buildPageModuleContent, generatePageTypes, type PageDefinition } from '../src/pages-types'

const CLI_BIN_PATH = resolve(import.meta.dir, '../src/bin.ts')

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
  // `bunx guren codegen` regenerates .guren/*.gen.ts on every run. These
  // files are generated artifacts, not user source, so codegen defaults
  // `force: true` when calling the generators (see codegenCommand in
  // packages/cli/src/bin.ts). Without this, plain `bunx guren codegen`
  // fails on the second run with "already exists. Use --force to overwrite."
  // even though create-app templates and the agent-harness docs assume a
  // plain re-run just works.
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

  // Regression test for `codegenCommand` itself (packages/cli/src/bin.ts),
  // not just the generator it calls — this is what actually reproduces the
  // original bug report ("already exists. Use --force to overwrite." on a
  // plain second `bunx guren codegen` run). The tests above exercise
  // generatePageTypes() directly with force passed explicitly either way,
  // so they'd pass unchanged even if codegenCommand stopped forcing it.
  it('codegen CLI command overwrites existing artifacts on a second run without --force', async () => {
    const workspace = await createTempWorkspace('guren-cli-codegen-command-')
    try {
      await mkdir(join(workspace.dir, 'resources/js/pages'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'resources/js/pages/Home.tsx'),
        'export default function Home() { return null }\n',
        'utf8',
      )

      const runCodegen = () =>
        Bun.spawn(['bun', CLI_BIN_PATH, 'codegen', '--app', workspace.dir], {
          stdout: 'pipe',
          stderr: 'pipe',
        })

      const first = runCodegen()
      expect(await first.exited).toBe(0)

      // No routes/web.ts exists in this fixture, so the command generates
      // pages.gen.ts, warns that routes/data/channel/API-client generation
      // was skipped, and exits 0 — exercising the exact write path the
      // original bug hit without needing a full routes/schema fixture.
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
