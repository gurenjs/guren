import { describe, expect, it } from 'bun:test'
import { definePage, resolvePagePath } from '../src/contracts'
import { createPagesResolver, defaultResolveComponentPath } from '../src/resolve'

describe('createPagesResolver', () => {
  it('throws when pages map is missing', () => {
    expect(() => createPagesResolver({})).toThrow('Inertia page resolution requires either a `resolve` function')
  })

  it('resolves a component using the default path', async () => {
    const module = { default: () => null }
    const loader = async () => module
    const pages = {
      './pages/Dashboard.tsx': loader,
    }

    const resolve = createPagesResolver({ pages })
    const resolved = await resolve('Dashboard')

    expect(resolved).toBe(module)
  })

  it('resolves a component using a custom path resolver', async () => {
    const module = { default: () => null }
    const loader = async () => module
    const pages = {
      './custom/Overview.tsx': loader,
    }

    const resolve = createPagesResolver({
      pages,
      resolveComponentPath: (name) => `./custom/${name}.tsx`,
    })

    const resolved = await resolve('Overview')
    expect(resolved).toBe(module)
  })

  it('resolves a component using the generated page manifest', async () => {
    const module = { default: () => null }
    const loader = async () => module
    const pages = {
      './pages/auth/Login.tsx': loader,
    }

    const resolve = createPagesResolver({
      pages,
      pageManifest: {
        'auth/Login': './pages/auth/Login.tsx',
      },
    })

    const resolved = await resolve('auth/Login')
    expect(resolved).toBe(module)
  })
})

describe('defaultResolveComponentPath', () => {
  it('maps names to the pages directory', () => {
    expect(defaultResolveComponentPath('dashboard/Index')).toBe('./pages/dashboard/Index.tsx')
  })
})

describe('definePage', () => {
  it('creates typed page contracts with specialized props', () => {
    const page = definePage('dashboard/Index', { path: './pages/dashboard/Index.tsx' }).props<{
      user: { id: number }
    }>()

    expect(page.id).toBe('dashboard/Index')
    expect(page.component).toBe('dashboard/Index')
    expect(page.path).toBe('./pages/dashboard/Index.tsx')
  })
})

describe('resolvePagePath', () => {
  it('returns paths from a page manifest', () => {
    expect(resolvePagePath('profile/Edit', { 'profile/Edit': './pages/profile/Edit.tsx' })).toBe(
      './pages/profile/Edit.tsx',
    )
  })
})
