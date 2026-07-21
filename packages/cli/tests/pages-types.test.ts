import { describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { buildPageModuleContent, generatePageTypes, type PageDefinition } from '../src/pages-types'

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
})
