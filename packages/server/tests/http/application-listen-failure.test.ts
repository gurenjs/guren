import { describe, expect, test } from 'bun:test'

const application = new URL('../../src/http/Application.ts', import.meta.url).href

// A subprocess proves startup returns control; spying on process.exit would let
// the caller continue even when production callers cannot.
describe('Application.listen startup failures', () => {
  for (const failure of ['create', 'listen', 'close', 'timeout'] as const) {
    test(`returns the ${failure} failure to the caller and permits a later listen`, async () => {
      const script = `
        import { mock } from 'bun:test'
        process.env.NODE_ENV = 'development'
        process.env.GUREN_DEV_BANNER = '0'
        process.env.GUREN_DEV_VITE = '1'
        process.env.GUREN_VITE_CLOSE_TIMEOUT_MS = '10'
        delete process.env.VITE_DEV_SERVER_URL
        delete process.env.GUREN_MANAGED_VITE_DEV_SERVER
        delete process.env.GUREN_INERTIA_ENTRY
        const mode = ${JSON.stringify(failure)}
        const startupError = new Error('startup failed')
        let attempts = 0
        let closes = 0
        let binds = 0
        mock.module('vite', () => ({ createServer: async () => {
          const first = ++attempts === 1
          if (first && mode === 'create') throw startupError
          return {
            async listen() { if (first) throw startupError },
            async close() {
              closes++
              if (first && mode === 'close') throw new Error('cleanup failed')
              if (first && mode === 'timeout') await new Promise(() => {})
            },
            httpServer: { listening: true },
            resolvedUrls: { local: ['http://localhost:5174'], network: [] },
          }
        } }))
        Bun.serve = () => { binds++; return { port: 3000, hostname: '127.0.0.1', stop() {} } }
        const { Application } = await import(${JSON.stringify(application)})
        const counts = () => ['SIGINT', 'SIGTERM', 'exit'].map(name => process.listenerCount(name))
        const before = counts()
        const app = new Application()
        let caught
        let cleanup = false
        try { await app.listen() }
        catch (error) { caught = { message: error.message, originalCause: error.cause === startupError } }
        finally { cleanup = true }
        const failed = {
          caught, cleanup, closes, binds, handlers: counts(),
          noAddress: app.address === undefined,
          noVite: globalThis.__gurenActiveViteDevServer === undefined,
          noUrl: process.env.VITE_DEV_SERVER_URL === undefined,
        }
        const address = await app.listen()
        await app.stop()
        console.log(JSON.stringify({ before, failed, address, closes, binds, handlers: counts(),
          stopped: app.address === undefined && process.env.VITE_DEV_SERVER_URL === undefined }))
      `
      const child = Bun.spawn([process.execPath, '--eval', script], {
        stdout: 'pipe', stderr: 'pipe', timeout: 15_000, killSignal: 'SIGKILL',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      expect({ code, signal: child.signalCode }).toEqual({ code: 0, signal: null })
      const result = JSON.parse(stdout)
      expect(result.failed).toEqual({
        caught: { message: 'Failed to start Vite dev server: startup failed', originalCause: true },
        cleanup: true, closes: failure === 'create' ? 0 : 1, binds: 0,
        handlers: result.before, noAddress: true, noVite: true, noUrl: true,
      })
      expect(result.address.url).toBe('http://127.0.0.1:3000')
      expect(result.closes).toBe(failure === 'create' ? 1 : 2)
      expect(result.binds).toBe(1)
      expect(result.handlers).toEqual(result.before)
      expect(result.stopped).toBe(true)
      if (failure === 'close') expect(stderr).toContain('cleanup failed')
      else if (failure === 'timeout') expect(stderr).toContain('did not close within 10ms')
      else expect(stderr).toBe('')
    }, 20_000)
  }
})
