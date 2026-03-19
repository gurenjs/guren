import { describe, expect, it, spyOn } from 'bun:test'
import { registerRootPublicAssets } from '../../src/http/public-assets'

describe('registerRootPublicAssets', () => {
  it('serves matching assets from the public directory', async () => {
    const middlewares: Array<(ctx: any, next: () => Promise<unknown>) => Promise<Response | void>> = []
    const app = {
      hono: {
        use: (fn: any) => middlewares.push(fn),
      },
    } as any

    const bunRef = (
      globalThis as {
        Bun?: {
          file?: (...args: any[]) => any
        }
      }
    ).Bun
    const originalBunFile = bunRef?.file
    const fileMock = {
      exists: async () => true,
      type: 'text/plain',
    }
    if (bunRef) {
      bunRef.file = () => fileMock
    }

    try {
      registerRootPublicAssets(app, '/public', { extensions: ['txt'], routePrefix: '/assets' })
      expect(middlewares).toHaveLength(1)

      const nextRef = { fn: async () => undefined }
      const nextSpy = spyOn(nextRef, 'fn')
      const response = await middlewares[0]({ req: { path: '/assets/readme.txt' } }, nextRef.fn)

      expect(nextSpy).not.toHaveBeenCalled()
      expect(response?.headers.get('Cache-Control')).toContain('max-age')
      expect(response?.headers.get('Content-Type')).toContain('text/plain')
    } finally {
      if (bunRef) {
        bunRef.file = originalBunFile
      }
    }
  })

  it('skips unmatched routes', async () => {
    const middlewares: Array<(ctx: any, next: () => Promise<unknown>) => Promise<Response | void>> = []
    const app = {
      hono: {
        use: (fn: any) => middlewares.push(fn),
      },
    } as any

    const bunRef = (
      globalThis as {
        Bun?: {
          file?: (...args: any[]) => any
        }
      }
    ).Bun
    const originalBunFile = bunRef?.file
    if (bunRef) {
      bunRef.file = () => ({ exists: async () => true })
    }

    try {
      registerRootPublicAssets(app, '/public', { extensions: ['txt'], routePrefix: '/assets' })
      const nextRef = { fn: async () => undefined }
      const nextSpy = spyOn(nextRef, 'fn')
      await middlewares[0]({ req: { path: '/static/logo.png' } }, nextRef.fn)

      expect(nextSpy).toHaveBeenCalled()
    } finally {
      if (bunRef) {
        bunRef.file = originalBunFile
      }
    }
  })
})
