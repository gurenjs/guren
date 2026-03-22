import { describe, expect, it } from 'bun:test'
import { buildPageModuleContent, type PageDefinition } from '../src/pages-types'

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
