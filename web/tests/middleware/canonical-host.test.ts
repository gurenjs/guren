import { describe, expect, it } from 'vitest'
import { redirectToCanonicalHost } from '../../app/Http/Middleware/canonical-host.js'

type MiddlewareContext = Parameters<typeof redirectToCanonicalHost>[0]

function contextFor(url: string) {
  let redirectedTo: string | undefined
  let redirectStatus: number | undefined

  const ctx = {
    req: { url },
    redirect: (target: string, status: number) => {
      redirectedTo = target
      redirectStatus = status
      return new Response(null, { status, headers: { location: target } })
    },
  } as unknown as MiddlewareContext

  return {
    ctx,
    get redirectedTo() {
      return redirectedTo
    },
    get redirectStatus() {
      return redirectStatus
    },
  }
}

async function run(url: string) {
  const probe = contextFor(url)
  let reachedApp = false

  await redirectToCanonicalHost(probe.ctx, async () => {
    reachedApp = true
  })

  return { ...probe, reachedApp }
}

describe('redirectToCanonicalHost', () => {
  it('should send www to the bare host permanently', async () => {
    const result = await run('https://www.guren.dev/docs/guides/routing')

    expect(result.redirectStatus).toBe(301)
    expect(result.redirectedTo).toBe('https://guren.dev/docs/guides/routing')
    expect(result.reachedApp).toBe(false)
  })

  it('should preserve the query string', async () => {
    const result = await run('https://www.guren.dev/search?q=inertia&page=2')

    expect(result.redirectedTo).toBe('https://guren.dev/search?q=inertia&page=2')
  })

  it('should leave the bare host alone', async () => {
    const result = await run('https://guren.dev/blog')

    expect(result.reachedApp).toBe(true)
    expect(result.redirectedTo).toBeUndefined()
  })

  it('should not touch hosts that merely contain www', async () => {
    // Only a leading `www.` is a hostname to redirect away from — stripping
    // it anywhere else would send visitors to a host that does not exist.
    const result = await run('https://wwwguren.dev/blog')

    expect(result.reachedApp).toBe(true)
  })

  it('should leave local and preview hosts alone', async () => {
    for (const url of ['http://localhost:3333/', 'https://guren-web.workers.dev/docs']) {
      expect((await run(url)).reachedApp).toBe(true)
    }
  })
})
