import { describe, expect, it } from 'bun:test'
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
})

describe('defaultResolveComponentPath', () => {
  it('maps names to the pages directory', () => {
    expect(defaultResolveComponentPath('dashboard/Index')).toBe('./pages/dashboard/Index.tsx')
  })
})
