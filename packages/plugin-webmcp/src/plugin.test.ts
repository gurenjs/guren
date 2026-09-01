/**
 * The server half's only observable behaviour: the origin-trial header.
 *
 * Driven through a real booted `createApp`, not by calling the middleware
 * directly, because the thing most likely to break is *when* the middleware
 * is mounted — a global middleware registered after the router mounts applies
 * to no route the app declared, and a unit test of the handler would pass
 * either way.
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
    // The other token is set by the *handler*, so it is on the response
    // before this plugin's middleware unwinds. A middleware setting its own
    // afterwards would pass an ordering test — it runs first and has nothing
    // to overwrite yet — which is why the collision is staged from the inside
    // out instead.
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
    // One header per token is how a browser reads several trials; overwriting
    // would silently disable whichever was already there. Headers.get joins
    // repeated field lines with ", ", so both tokens have to be in the value.
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
