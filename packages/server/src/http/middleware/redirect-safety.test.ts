import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { createRedirectSafetyMiddleware, isSafeRedirectUrl } from './redirect-safety'

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
