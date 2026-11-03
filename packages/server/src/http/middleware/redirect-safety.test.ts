import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { createRedirectSafetyMiddleware, isSafeRedirectUrl, sameHostRefererPath } from './redirect-safety'

describe('isSafeRedirectUrl', () => {
  const requestUrl = 'http://example.com/current'

  test('should allow relative URLs', () => {
    expect(isSafeRedirectUrl('/dashboard', requestUrl)).toBe(true)
    expect(isSafeRedirectUrl('/login?next=/home', requestUrl)).toBe(true)
  })

  test('should allow same-origin absolute URLs', () => {
    expect(isSafeRedirectUrl('http://example.com/other', requestUrl)).toBe(true)
  })

  test('should reject different-origin URLs', () => {
    expect(isSafeRedirectUrl('http://evil.com/phish', requestUrl)).toBe(false)
  })

  test('should reject protocol-relative URLs', () => {
    expect(isSafeRedirectUrl('//evil.com/phish', requestUrl)).toBe(false)
  })

  test('should reject backslash tricks', () => {
    expect(isSafeRedirectUrl('\\/evil.com', requestUrl)).toBe(false)
  })

  test('should reject tab and newline tricks a browser collapses to //', () => {
    expect(isSafeRedirectUrl('/\t/evil.com', requestUrl)).toBe(false)
    expect(isSafeRedirectUrl('/\t\\evil.com', requestUrl)).toBe(false)
    expect(isSafeRedirectUrl('/\n/evil.com', requestUrl)).toBe(false)
    expect(isSafeRedirectUrl('/\r\n/evil.com', requestUrl)).toBe(false)
  })

  test('should allow URLs to allowed hosts', () => {
    expect(isSafeRedirectUrl('https://accounts.google.com/auth', requestUrl, ['accounts.google.com'])).toBe(true)
  })

  test('should support wildcard allowed hosts', () => {
    expect(isSafeRedirectUrl('https://app.example.org/cb', requestUrl, ['*.example.org'])).toBe(true)
    expect(isSafeRedirectUrl('https://evil.com/cb', requestUrl, ['*.example.org'])).toBe(false)
  })

  test('should return false for malformed URLs', () => {
    expect(isSafeRedirectUrl('javascript:alert(1)', requestUrl)).toBe(false)
  })
})

describe('createRedirectSafetyMiddleware', () => {
  test('should rewrite unsafe redirects to fallback URL', async () => {
    const app = new Hono()
    app.use('*', createRedirectSafetyMiddleware())
    app.get('/redirect', (c) => c.redirect('http://evil.com/phish'))

    const res = await app.request('http://example.com/redirect')

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/')
  })

  test('should rewrite a query-supplied target hiding // behind a tab', async () => {
    const app = new Hono()
    app.use('*', createRedirectSafetyMiddleware())
    app.get('/redirect', (c) => c.redirect(c.req.query('next') ?? '/'))

    const res = await app.request('http://example.com/redirect?next=%2F%09%2Fevil.com')

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/')
  })

  test('should allow safe redirects through', async () => {
    const app = new Hono()
    app.use('*', createRedirectSafetyMiddleware())
    app.get('/redirect', (c) => c.redirect('/dashboard'))

    const res = await app.request('http://example.com/redirect')

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/dashboard')
  })

  test('should not affect non-redirect responses', async () => {
    const app = new Hono()
    app.use('*', createRedirectSafetyMiddleware())
    app.get('/', (c) => c.text('ok'))

    const res = await app.request('http://example.com/')

    expect(res.status).toBe(200)
  })

  test('should use custom fallback URL', async () => {
    const app = new Hono()
    app.use('*', createRedirectSafetyMiddleware({ fallbackUrl: '/error' }))
    app.get('/redirect', (c) => c.redirect('http://evil.com/'))

    const res = await app.request('http://example.com/redirect')

    expect(res.headers.get('Location')).toBe('/error')
  })

  test('should allow configured external hosts', async () => {
    const app = new Hono()
    app.use('*', createRedirectSafetyMiddleware({
      allowedHosts: ['accounts.google.com'],
    }))
    app.get('/redirect', (c) => c.redirect('https://accounts.google.com/auth'))

    const res = await app.request('http://example.com/redirect')

    expect(res.headers.get('Location')).toBe('https://accounts.google.com/auth')
  })
})

describe('sameHostRefererPath', () => {
  const requestUrl = 'http://example.com/posts'
  const hosts = ['example.com']
  const back = (referer: string | undefined, fallback?: string) => sameHostRefererPath(referer, requestUrl, hosts, fallback)

  test('keeps the path and query of a Referer on an accepted host, whatever its scheme', () => {
    expect(back('http://example.com/posts/1/edit')).toBe('/posts/1/edit')
    expect(back('https://example.com/posts/1/edit?tab=body')).toBe('/posts/1/edit?tab=body')
    expect(back('/posts/create')).toBe('/posts/create')
  })

  // A proxy that does not forward Host hands the app its upstream address.
  test('accepts the configured app host when the request names the upstream one', () => {
    const upstream = 'http://10.0.0.5:3000/posts'

    expect(sameHostRefererPath('https://app.example.com/posts/1/edit', upstream, ['10.0.0.5:3000', 'app.example.com'])).toBe('/posts/1/edit')
    expect(sameHostRefererPath('https://app.example.com/posts/1/edit', upstream, ['10.0.0.5:3000'])).toBe('/')
  })

  test('keeps a backslash in the query', () => {
    expect(back('http://example.com/search?q=a\\b')).toBe('/search?q=a\\b')
  })

  test('drops the userinfo of an accepted Referer', () => {
    expect(back('http://user:secret@example.com/form')).toBe('/form')
  })

  test('falls back for a missing Referer or one on a host or port not accepted', () => {
    expect(back(undefined)).toBe('/')
    expect(back('')).toBe('/')
    expect(back('https://evil.example/x')).toBe('/')
    expect(back('http://example.com:8080/x')).toBe('/')
    expect(sameHostRefererPath('http://example.com:8080/x', requestUrl, ['example.com', 'example.com:8080'])).toBe('/x')
    expect(back('https://evil.example/x', '/home')).toBe('/home')
  })

  test('falls back for a Referer whose path a browser reads as another host', () => {
    expect(back('//evil.example/x')).toBe('/')
    expect(back('/\\evil.example/x')).toBe('/')
    expect(back('/\t/evil.example/x')).toBe('/')
    expect(back(' //evil.example/x')).toBe('/')
    expect(back('\u0001//evil.example/x')).toBe('/')
    expect(back('http://example.com//evil.example/x')).toBe('/')
    expect(back('http://example.com/\\evil.example/x')).toBe('/')
    expect(back('http://example.com/..//evil.example/x')).toBe('/')
    expect(back('http://evil.example\\@example.com/x')).toBe('/')
  })

  test('falls back for a scheme other than http and https', () => {
    expect(back('javascript://example.com/%0aalert(1)')).toBe('/')
    expect(back('data:text/html,hi')).toBe('/')
  })
})
