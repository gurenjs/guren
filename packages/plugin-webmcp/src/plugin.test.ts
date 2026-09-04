/**
 * The server half's only observable behaviour: the origin-trial header. Driven
 * through a real booted `createApp` because what is most likely to break is
 * *when* the middleware is mounted — one registered after the router mounts
 * applies to no route, and a unit test of the handler would pass either way.
 */
import { describe, test, expect } from 'bun:test'
import { createApp, type Application, type Router } from '@guren/core'
import { webMcpPlugin, type WebMcpPluginConfig } from './plugin'

function appWith(config?: WebMcpPluginConfig): Application {
  return createApp({
    routes: (router: Router) => {
      router.get('/posts', () => Response.json({ posts: [] })).name('posts.index')
    },
    providers: [webMcpPlugin(config)],
  })
}

describe('webMcpPlugin', () => {
  test('should serve the origin-trial token on an application route', async () => {
    const app = appWith({ originTrial: 'trial-token' })
    await app.boot()

    const response = await app.fetch(new Request('http://localhost/posts'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Origin-Trial')).toBe('trial-token')
  })

  test('should append rather than replace a token already on the response', async () => {
    // The other token is set by the *handler*, so it is on the response before
    // this plugin's middleware unwinds. A middleware setting its own first
    // would pass an ordering test with nothing to overwrite yet.
    const app = createApp({
      routes: (router: Router) => {
        router
          .get(
            '/posts',
            () =>
              new Response(JSON.stringify({ posts: [] }), {
                headers: { 'Content-Type': 'application/json', 'Origin-Trial': 'other-token' },
              }),
          )
          .name('posts.index')
      },
      providers: [webMcpPlugin({ originTrial: 'webmcp-token' })],
    })
    await app.boot()

    const response = await app.fetch(new Request('http://localhost/posts'))
    // Headers.get joins repeated field lines with ", ", so both tokens have to
    // be in the value.
    const served = response.headers.get('Origin-Trial')
    expect(served).toContain('webmcp-token')
    expect(served).toContain('other-token')
  })

  test('should register nothing without a token', async () => {
    const app = appWith()
    await app.boot()

    const response = await app.fetch(new Request('http://localhost/posts'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Origin-Trial')).toBeNull()
  })
})
